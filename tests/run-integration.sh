#!/usr/bin/env bash
# End-to-end integration tests against an isolated database, upload dir and backup dir.
# Requires: PostgreSQL 13+ (running, and the connecting role may CREATE DATABASE), a production
# build (.next), Node 22, and these on PATH: curl jq awk base64 openssl node npx psql pg_dump
# pg_restore tar python3. Preflight below checks all of them before it touches anything.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${TEST_PORT:-3100}"
TLS_PORT="${TEST_TLS_PORT:-3443}"
BASE="http://127.0.0.1:${PORT}"
TLS_BASE="https://127.0.0.1:${TLS_PORT}"
TEST_DB="${TEST_DATABASE_NAME:-family_chat_test}"
RESTORE_DB="${TEST_RESTORE_DATABASE_NAME:-family_chat_test_restore}"
TEST_ROOT="$ROOT/test-results/integration"
UPLOAD_DIR="$TEST_ROOT/uploads"
BACKUP_DIR="$TEST_ROOT/backups"
JAR_OWNER="$TEST_ROOT/owner.jar"
JAR_MIRA="$TEST_ROOT/mira.jar"
JAR_MIRA2="$TEST_ROOT/mira2.jar"
JAR_TESTER="$TEST_ROOT/tester.jar"
JAR_EMPTY="$TEST_ROOT/empty.jar"
JAR_TLS="$TEST_ROOT/tls.jar"
BODY="$TEST_ROOT/body.out"
SERVER_LOG="$TEST_ROOT/server.log"
TLS_LOG="$TEST_ROOT/tls.log"
TLS_SERVER_PID=""
SERVER_PID=""
MOCK_PID=""

PASS=0
FAILURES=0

pass() { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1" >&2; exit 1; }
section() { printf '\n== %s ==\n' "$1"; }

assert_status() {
  local expected="$1" code="$2" msg="$3"
  if [[ " $expected " != *" $code "* ]]; then
    printf '%s\n' '--- response body ---' >&2
    head -c 4000 "$BODY" >&2 || true
    printf '\n' >&2
    fail "$msg (expected HTTP [$expected], got $code)"
  fi
  pass "$msg"
}

assert_status_no_body() {
  local expected="$1" code="$2" msg="$3"
  if [[ " $expected " != *" $code "* ]]; then
    fail "$msg (expected HTTP [$expected], got $code)"
  fi
  pass "$msg"
}

assert_jq() {
  local expr="$1" msg="$2"
  if ! jq -e "$expr" "$BODY" >/dev/null 2>&1; then
    printf '%s\n' '--- response body ---' >&2
    head -c 4000 "$BODY" >&2 || true
    printf '\n' >&2
    fail "$msg"
  fi
  pass "$msg"
}

json_val() { jq -r "$1" "$BODY"; }
json_n() { jq -cn "$@"; }

csrf_of() { awk '$6 == "fac_csrf" { print $7 }' "$1" | tail -n 1; }

api() {
  local method="$1" path="$2" jar="$3" payload="${4:-}" csrf="${5:-}"
  local args=(-sS -o "$BODY" -w '%{http_code}' -X "$method" -b "$jar" -c "$jar")
  if [[ -n "$payload" ]]; then
    args+=(-H 'content-type: application/json' --data-binary "$payload")
  fi
  if [[ -n "$csrf" ]]; then
    args+=(-H "x-csrf-token: $csrf")
  fi
  curl "${args[@]}" "$BASE$path"
}

download_api() {
  local path="$1" jar="$2" payload="$3" csrf="$4" out="$5"
  curl -sS -o "$out" -w '%{http_code}' -X POST -b "$jar" \
    -H 'content-type: application/json' -H "x-csrf-token: $csrf" \
    --data-binary "$payload" "$BASE$path"
}

last_email_code() {
  grep -o 'Verification code: [0-9]\{6\}' "$SERVER_LOG" | tail -n 1 | grep -o '[0-9]\{6\}'
}

wait_for_health() {
  local url="$1" log="$2" i code
  for i in $(seq 1 120); do
    code=$(curl -sk -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)
    [[ "$code" == "200" ]] && return 0
    sleep 0.5
  done
  printf '%s\n' "--- $log (tail) ---" >&2
  tail -n 60 "$log" >&2 || true
  return 1
}

cleanup() {
  if [[ -n "$TLS_SERVER_PID" ]] && kill -0 "$TLS_SERVER_PID" 2>/dev/null; then
    kill "$TLS_SERVER_PID" 2>/dev/null || true
    wait "$TLS_SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "$MOCK_PID" ]] && kill -0 "$MOCK_PID" 2>/dev/null; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------- environment
[[ -f .env ]] || { echo 'missing .env' >&2; exit 1; }
[[ -f .next/BUILD_ID ]] || { echo 'missing production build; run npm run build' >&2; exit 1; }

section 'Preflight: required tools and database rights'

# 缺依赖必须在这里停下，而不是在第 255 行才炸。jq 那一例最阴：json_n 里的 `jq -cn` 失败发生在
# 命令替换里，set -e 不终止命令替换，于是 payload 是空串，256 行的断言报
# 「expected HTTP [401], got 400」——看起来完全像产品回归，其实是机器上没装 jq。
# 这里 exit 而不是 fail()：缺工具是「没跑成」，不是「跑失败」，不该被计入一条产品失败。
missing_tools=()
for tool in curl jq awk base64 openssl node npx psql pg_dump pg_restore tar; do
  command -v "$tool" >/dev/null 2>&1 || missing_tools+=("$tool")
done
# python3 在 Windows 上可能是 WindowsApps 的存根：command -v 找得到，一跑就退。所以探活不是探在。
{ command -v python3 >/dev/null 2>&1 && python3 -c 'import sys' >/dev/null 2>&1; } \
  || missing_tools+=('python3(存在但不可执行)')
if ((${#missing_tools[@]})); then
  printf 'missing required tools: %s\n' "${missing_tools[*]}" >&2
  printf 'install: Debian/Ubuntu  apt-get install -y curl jq coreutils openssl postgresql-client tar python3\n' >&2
  printf '         RHEL/Fedora     dnf install -y curl jq coreutils openssl postgresql tar python3\n' >&2
  printf '         macOS           brew install jq coreutils openssl libpq python3\n' >&2
  printf '         Git Bash        winget/scoop 装 PostgreSQL 客户端并把其 bin 目录加入 PATH\n' >&2
  printf 'note: pg_dump / pg_restore / tar 不在本脚本里调用，但备份与恢复那两节会让**服务进程**去 exec 它们\n' >&2
  exit 1
fi
pass 'all required tools present'

MAIN_URL=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-)
MAIN_DB="${MAIN_URL%%\?*}"
DB_PREFIX="${MAIN_DB%/*}"
TEST_DB_PLAIN="$DB_PREFIX/$TEST_DB"
RESTORE_DB_PLAIN="$DB_PREFIX/$RESTORE_DB"
TEST_DB_URL="$TEST_DB_PLAIN?schema=public"
RESTORE_DB_URL="$RESTORE_DB_PLAIN?schema=public"

# 建库权限和版本也要在这儿问清楚：下面那句 CREATE DATABASE 失败会被 set -e 直接带走，
# 现场只剩一句 psql 报错，看不出「超级用户的 rolcreatedb 同样是 f」这种形状。
# 两次探测连的都是 `$DB_PREFIX/postgres`，和后面建库那两句同一个目标，所以这里的失败就是那里的失败。
# 连接串里有密码：stderr 先收进变量、滤掉带 scheme 的行再转述，任何情况下都不回显 $MAIN_URL。
role_probe=$(psql "$DB_PREFIX/postgres" -At -v ON_ERROR_STOP=1 \
  -c "select case when rolsuper or rolcreatedb then 'ok' else 'no' end from pg_roles where rolname = current_user" 2>&1) \
  || { printf 'cannot read the connecting role: %s\n' "$(printf '%s\n' "$role_probe" | grep -v '://' | head -n 3)" >&2; exit 1; }
[[ "$role_probe" == "ok" ]] \
  || { echo 'the connecting role can neither CREATE DATABASE nor is a superuser: the isolated test databases cannot be provisioned' >&2; exit 1; }
pass 'connecting role can create databases'

version_probe=$(psql "$DB_PREFIX/postgres" -At -v ON_ERROR_STOP=1 -c "show server_version_num" 2>&1) \
  || { printf 'cannot read the server version: %s\n' "$(printf '%s\n' "$version_probe" | grep -v '://' | head -n 3)" >&2; exit 1; }
{ [[ "$version_probe" =~ ^[0-9]+$ ]] && ((version_probe >= 130000)); } \
  || { echo "PostgreSQL 13+ is required (got ${version_probe:-unreadable}): DROP DATABASE ... WITH (FORCE) does not exist before 13, so a test database still held open cannot be reclaimed" >&2; exit 1; }
pass 'PostgreSQL is 13 or newer'

OWNER_PW="Fam-$(openssl rand -hex 8)!Aa1"
MIRA_PW="Blue-$(openssl rand -hex 8)!Aa1"
MIRA_PW2="Harbor-$(openssl rand -hex 8)!Aa1"
MIRA_PW3="Cedar-$(openssl rand -hex 8)!Aa1"
API_KEY="sk-it-$(openssl rand -hex 12)"
MIRA_EMAIL="mira@test.local"

rm -rf "$TEST_ROOT"
mkdir -p "$TEST_ROOT" "$UPLOAD_DIR" "$BACKUP_DIR"
touch "$JAR_OWNER" "$JAR_MIRA" "$JAR_MIRA2" "$JAR_TESTER" "$JAR_EMPTY" "$JAR_TLS"
chmod 700 "$TEST_ROOT"

section 'Provision isolated database'
psql "$DB_PREFIX/postgres" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS \"$TEST_DB\" WITH (FORCE);"
psql "$DB_PREFIX/postgres" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"$TEST_DB\";"
DATABASE_URL="$TEST_DB_URL" npx prisma migrate deploy >"$TEST_ROOT/migrate.log" 2>&1
pass 'fresh test database migrated'

printf '%s\n' "$OWNER_PW" | \
  env DATABASE_URL="$TEST_DB_URL" UPLOAD_DIR="$UPLOAD_DIR" BACKUP_DIR="$BACKUP_DIR" \
  NODE_ENV=production ALLOW_INSECURE_COOKIES=true \
  npx tsx scripts/bootstrap.ts --username owner --email owner@test.local --password-stdin \
    --site-name 'Integration Test' \
  >"$TEST_ROOT/bootstrap.log" 2>&1
pass 'owner bootstrapped from stdin (no default password)'

# ------------------------------------------------------------------- services
section 'Start mock AI and application'
if curl -sf --max-time 1 -H 'Authorization: Bearer readiness' http://127.0.0.1:4010/v1/models >/dev/null 2>&1; then
  pass 'mock AI already running on :4010'
else
  nohup node tests/mock-ai.mjs >"$TEST_ROOT/mock-ai.log" 2>&1 &
  MOCK_PID=$!
  for _ in $(seq 1 40); do
    curl -sf --max-time 1 -H 'Authorization: Bearer readiness' http://127.0.0.1:4010/v1/models >/dev/null 2>&1 && break
    sleep 0.25
  done
  curl -sf --max-time 2 -H 'Authorization: Bearer readiness' http://127.0.0.1:4010/v1/models >/dev/null 2>&1 || fail 'mock AI did not start'
  pass 'mock AI started on :4010'
fi

env \
  DATABASE_URL="$TEST_DB_URL" PORT="$PORT" HOST=0.0.0.0 APP_URL="$BASE" \
  NODE_ENV=production ALLOW_INSECURE_COOKIES=true COOKIE_SECURE=false \
  UPLOAD_DIR="$UPLOAD_DIR" BACKUP_DIR="$BACKUP_DIR" EMAIL_TRANSPORT=console \
  ALLOW_PRIVATE_AI_URLS=true IP_CACHE_MS=250 TRUST_PROXY=true \
  TRUSTED_PROXY_CIDRS='127.0.0.1/32,::1/128' LOG_LEVEL=warn \
  nohup node server.js >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
wait_for_health "$BASE/api/health" "$SERVER_LOG" || fail 'application did not become healthy'
pass "application healthy on :$PORT"

# ------------------------------------------------------------ network gate
section 'Network-layer IP allowlist (before login, static files and APIs)'
code=$(curl -sS -o "$BODY" -w '%{http_code}' "$BASE/api/health")
assert_status 200 "$code" 'allowed loopback reaches /api/health'

code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/chat")
assert_status_no_body '302 307' "$code" 'unauthenticated /chat redirects to login'

code=$(curl --interface 127.0.0.2 -sS -o "$BODY" -w '%{http_code}' "$BASE/api/health")
assert_status 403 "$code" 'unlisted IP denied at API'
grep -q '403' "$BODY" || true

code=$(curl --interface 127.0.0.2 -sS -o /dev/null -w '%{http_code}' "$BASE/")
assert_status_no_body 403 "$code" 'unlisted IP denied at site root'

code=$(curl --interface 127.0.0.2 -sS -o /dev/null -w '%{http_code}' "$BASE/_next/static/chunks/not-a-real-file.js")
assert_status_no_body 403 "$code" 'unlisted IP denied for static assets'

code=$(curl --interface 127.0.0.2 -sS -o /dev/null -w '%{http_code}' \
  -H 'X-Real-IP: 127.0.0.1' -H 'X-Forwarded-For: 127.0.0.1' "$BASE/api/health")
assert_status_no_body 403 "$code" 'forged X-Real-IP / X-Forwarded-For from untrusted peer ignored'

code=$(curl -sS -o /dev/null -w '%{http_code}' -H 'X-Real-IP: 8.8.8.8' "$BASE/api/health")
assert_status_no_body 403 "$code" 'trusted proxy cannot claim an unlisted client IP'

# --------------------------------------------------------------- owner auth
section 'Authentication, sessions and CSRF'
code=$(api POST /api/auth/login "$JAR_OWNER" \
  "$(json_n --arg u owner --arg p 'wrong-password-2026' '{identifier:$u,password:$p}')")
assert_status 401 "$code" 'wrong password rejected'
assert_jq '.error.code == "INVALID_CREDENTIALS"' 'wrong password returns a generic error'

code=$(api POST /api/auth/login "$JAR_OWNER" \
  "$(json_n --arg u owner --arg p "$OWNER_PW" '{identifier:$u,password:$p}')")
assert_status 200 "$code" 'owner login succeeds'
grep -q '^#HttpOnly_.*fac_session' "$JAR_OWNER" || fail 'session cookie is not HttpOnly'
pass 'session cookie is HttpOnly'
OWNER_CSRF=$(csrf_of "$JAR_OWNER")
[[ -n "$OWNER_CSRF" ]] || fail 'CSRF cookie missing'

code=$(api GET /api/auth/me "$JAR_OWNER")
assert_status 200 "$code" 'session restores identity'
assert_jq '.data.user.role == "OWNER" and .data.user.username == "owner"' 'owner role is correct'
OWNER_ID=$(json_val '.data.user.id')

code=$(api PATCH /api/admin/config "$JAR_OWNER" '{"registrationOpen":true}' '')
assert_status 403 "$code" 'admin mutation without CSRF token is rejected'
assert_jq '.error.code == "CSRF_FAILED"' 'missing CSRF returns CSRF_FAILED'

code=$(api PATCH /api/admin/config "$JAR_OWNER" \
  "$(json_n --arg p "$OWNER_PW" '{registrationOpen:false,confirmPassword:$p}')" "$OWNER_CSRF")
assert_status 200 "$code" 'admin config requires password re-authentication'

# -------------------------------------------------------------- registration
section 'Registration, email verification and password policy'
code=$(api POST /api/auth/register/request "$JAR_EMPTY" \
  "$(json_n --arg u mira --arg e "$MIRA_EMAIL" '{username:$u,email:$e}')")
assert_status 403 "$code" 'registration is closed by default'
assert_jq '.error.code == "REGISTRATION_CLOSED"' 'registration-closed code'

code=$(api PATCH /api/admin/config "$JAR_OWNER" \
  "$(json_n --arg p "$OWNER_PW" '{registrationOpen:true,confirmPassword:$p}')" "$OWNER_CSRF")
assert_status 200 "$code" 'owner enables registration'

code=$(api POST /api/auth/register/request "$JAR_EMPTY" \
  "$(json_n --arg u mira --arg e "$MIRA_EMAIL" '{username:$u,email:$e}')")
assert_status 200 "$code" 'registration code requested'
CODE=$(last_email_code)
[[ "$CODE" =~ ^[0-9]{6}$ ]] || fail 'could not read verification code from console transport'

code=$(api POST /api/auth/register/verify "$JAR_EMPTY" \
  "$(json_n --arg e "$MIRA_EMAIL" --arg c "$CODE" --arg p 'mira-weak-123' \
    '{email:$e,code:$c,password:$p}')")
assert_status 400 "$code" 'weak password rejected during registration'
assert_jq '.error.code == "WEAK_PASSWORD"' 'weak-password code returned'

code=$(api POST /api/auth/register/verify "$JAR_MIRA" \
  "$(json_n --arg e "$MIRA_EMAIL" --arg c "$CODE" --arg p "$MIRA_PW" \
    '{email:$e,code:$c,password:$p}')")
assert_status 200 "$code" 'registration completes after policy failure (code not consumed)'
assert_jq '.data.user.role == "USER"' 'registered account is a normal user'

code=$(api POST /api/auth/register/verify "$JAR_EMPTY" \
  "$(json_n --arg e "$MIRA_EMAIL" --arg c "$CODE" --arg p "$MIRA_PW" \
    '{email:$e,code:$c,password:$p}')")
assert_status 400 "$code" 'verification code is single-use'

code=$(api POST /api/auth/register/request "$JAR_EMPTY" \
  "$(json_n --arg u mira --arg e 'other@test.local' '{username:$u,email:$e}')")
assert_status 409 "$code" 'duplicate username rejected'

MIRA_CSRF=$(csrf_of "$JAR_MIRA")
code=$(api GET /api/auth/me "$JAR_MIRA")
assert_status 200 "$code" 'registered user session works'
assert_jq '.data.user.role == "USER"' 'registered session has USER role'

# ------------------------------------------------------------ AI provider
section 'Global AI model and API key protection'
code=$(api POST /api/admin/providers "$JAR_OWNER" \
  "$(json_n --arg p "$OWNER_PW" --arg k "$API_KEY" \
    '{name:"Mock AI Integration",baseUrl:"http://127.0.0.1:4010/v1",apiKey:$k,modelId:"mock-model",capabilities:["text","vision","files","audio"],enabled:true,isDefault:true,confirmPassword:$p}')" \
  "$OWNER_CSRF")
assert_status 200 "$code" 'owner creates a global provider'
PROVIDER_ID=$(json_val '.data.provider.id')
assert_jq '.data.provider.hasApiKey == true and (.data.provider.apiKey == null)' 'API key is never returned to the browser'

CIPHER=$(psql "$TEST_DB_PLAIN" -Atc "select \"apiKeyCiphertext\" from \"AiProvider\" where id = '$PROVIDER_ID'")
[[ "$CIPHER" == enc:v1:* ]] || fail 'API key is not stored in enc:v1 format'
[[ "$CIPHER" != *"$API_KEY"* ]] || fail 'API key stored in plaintext'
pass 'API key ciphertext is AES-GCM and does not contain the key'

code=$(api POST "/api/admin/providers/$PROVIDER_ID/test" "$JAR_OWNER" '' "$OWNER_CSRF")
assert_status 200 "$code" 'provider test decrypts key and reaches /models'
assert_jq '.data.ok == true' 'provider connectivity test succeeded'

code=$(api GET /api/admin/service "$JAR_OWNER")
assert_status 200 "$code" 'service status available'
assert_jq '.data.database.ok == true and (.data.database.version != null)' 'database version is reported'
code=$(api GET /api/admin/overview "$JAR_OWNER")
assert_status 200 "$code" 'admin overview available'
assert_jq '.data.users.owners == 1' 'exactly one owner exists'

# ----------------------------------------------------------- chat + streaming
section 'Streaming chat, persistence and encrypted storage'
code=$(api POST /api/chats "$JAR_OWNER" '{}' "$OWNER_CSRF")
assert_status 200 "$code" 'owner creates a chat'
CHAT_OWNER=$(json_val '.data.chat.id')

curl -sS -N -b "$JAR_OWNER" -H "x-csrf-token: $OWNER_CSRF" \
  -H 'content-type: application/json' -H 'accept: text/event-stream' \
  --data-binary '{"content":"hello integration","attachmentIds":[]}' \
  "$BASE/api/chats/$CHAT_OWNER/messages" >"$TEST_ROOT/sse.txt"
grep -q '"type":"delta"' "$TEST_ROOT/sse.txt" || fail 'no delta event in SSE stream'
grep -q 'MOCK_REPLY: hello integration' "$TEST_ROOT/sse.txt" || fail 'mock reply missing from stream'
grep -q '"type":"done"' "$TEST_ROOT/sse.txt" || fail 'no done event in SSE stream'
pass 'streaming reply via OpenAI-compatible mock provider'

code=$(api GET "/api/chats/$CHAT_OWNER" "$JAR_OWNER")
assert_status 200 "$code" 'chat detail is readable'
assert_jq '.data.chat.messages | length == 2' 'user and assistant messages persisted'
assert_jq '.data.chat.messages[1].content == "MOCK_REPLY: hello integration"' 'assistant reply decrypts correctly'

TITLE_CIPHER=$(psql "$TEST_DB_PLAIN" -Atc "select \"titleCiphertext\" from \"Chat\" where id = '$CHAT_OWNER'")
[[ "$TITLE_CIPHER" == enc:v1:* ]] || fail 'chat title is not encrypted'
CONTENT_CIPHER=$(psql "$TEST_DB_PLAIN" -Atc "select \"contentCiphertext\" from \"Message\" where \"chatId\" = '$CHAT_OWNER' order by \"createdAt\" limit 1")
[[ "$CONTENT_CIPHER" == enc:v1:* && "$CONTENT_CIPHER" != *'hello integration'* ]] || fail 'message content is not encrypted at rest'
pass 'chat titles and messages are encrypted at rest'

code=$(api PATCH "/api/chats/$CHAT_OWNER" "$JAR_OWNER" '{"title":"Renamed by test"}' "$OWNER_CSRF")
assert_status 200 "$code" 'chat rename works'
code=$(api PATCH "/api/chats/$CHAT_OWNER/model" "$JAR_OWNER" "$(json_n --arg id "$PROVIDER_ID" '{providerId:$id}')" "$OWNER_CSRF")
assert_status 200 "$code" 'per-chat model switch works'

# ---------------------------------------------------- cognitive task queue
section 'Cognitive background task queue: real-database assertions'

# 这一节证明的是内存替身永远证明不了的四件事：迁移能落到干净库、约束长在库上而不是代码里、
# 过期租约被真实在跑的 worker 收回、以及那条队列真的跟着服务进程活着。
# 下面第一条闭环断言走的是「开关默认关 → 欠账作废删行」这条真实出口，
# 但真库里没有「开关打开 → 记忆真的写进 MemoryItem」的对照（要注入偏好才行，本片区没有那个旋钮），
# 所以「闸门开着会继续执行」那半边只有单测证据，docs/cognitive-acceptance.md 里如实标了未验收。

psql "$TEST_DB_PLAIN" -Atc "select coalesce(to_regclass('public.\"CognitiveTask\"')::text,'')" | grep -qx 'CognitiveTask' \
  || fail 'CognitiveTask table missing: the migration did not apply to a fresh database'
pass 'migration 20261103113000_cognitive_tasks applies to a fresh database'

[[ -f node_modules/.prisma/client/index.d.ts ]] && grep -q 'CognitiveTask' node_modules/.prisma/client/index.d.ts \
  || fail 'generated Prisma client has no CognitiveTask (schema changed without npm run db:generate)'
pass 'generated Prisma client is fresh for this schema'

grep -rq 'cognitiveTask' .next/server \
  || fail 'production build has no cognitiveTask reference (schema changed without npm run build)'
pass 'production build contains the task queue'

MSG_USER=$(psql "$TEST_DB_PLAIN" -Atc "select id from \"Message\" where \"chatId\" = '$CHAT_OWNER' and role = 'USER' order by \"createdAt\" limit 1")
MSG_ASSIST=$(psql "$TEST_DB_PLAIN" -Atc "select id from \"Message\" where \"chatId\" = '$CHAT_OWNER' and role = 'ASSISTANT' order by \"createdAt\" limit 1")
[[ -n "$MSG_USER" && -n "$MSG_ASSIST" ]] || fail 'no persisted message to anchor the queue rows'

# 出箱闭环：上面那一轮真实对话由路由欠下一条账，此刻必须已经被活着的 worker 处理掉。
# 新建用户的八个开关默认全关（任务书 1.1 那份 OFF），所以 worker 的出口是「作废删行」，痕迹只留在日志的事件名里。
# 先等日志再查库是有顺序的：入队发生在 controller.close() 之后，直接查库会在
# 「还没欠下来」的那一刻就误判成「已经排空」。
DISCARDED=0
for _ in $(seq 1 40); do
  if grep -Eq "\"event\":\"cognitive.task_discarded\".*\"sourceMessageId\":\"$MSG_USER\"" "$SERVER_LOG"; then
    DISCARDED=1
    break
  fi
  sleep 0.5
done
[[ "$DISCARDED" == "1" ]] || fail 'the running worker never handled the task the chat route enqueued'
pass 'chat turn enqueued a debt the running worker claimed and voided (switches default to off)'

if psql "$TEST_DB_PLAIN" -Atc "select 1 from \"CognitiveTask\" where \"sourceMessageId\" = '$MSG_USER'" | grep -q 1; then
  fail 'a voided task left its row in the queue'
fi
pass 'a voided task leaves no row behind: the table only holds outstanding work'

grep -q 'hello integration' "$SERVER_LOG" && fail 'the worker logged the message content' || true
pass 'the queue log line carries ids only, never the sentence itself'

# 唯一约束的真身：两条完全相同的欠账放在同一条语句里插进去，库层必须挡下来。
# 用单条多值 INSERT 而不是两条语句，是为了不给 worker 留出「先领走第一条」的时间窗。
# 两处形状是拿真库试出来的，不是想当然：id 的 @default(uuid()) 是 Prisma 在应用层生成的，
# 库里那列没有默认值，裸 SQL 必须自己给；INSERT ... SELECT 里的 'MEMORY' 会被推成 text
# 而不会自动转枚举（VALUES 形式才会），所以要写显式转换。
DUP_OUT=$(psql "$TEST_DB_PLAIN" -q -v ON_ERROR_STOP=1 -c "
INSERT INTO \"CognitiveTask\" (\"id\",\"userId\",\"chatId\",\"sourceMessageId\",\"kind\",\"updatedAt\")
SELECT 'dup-a','$OWNER_ID','$CHAT_OWNER','$MSG_USER','MEMORY'::\"CognitiveTaskKind\",now()
UNION ALL SELECT 'dup-b','$OWNER_ID','$CHAT_OWNER','$MSG_USER','MEMORY'::\"CognitiveTaskKind\",now();" 2>&1) \
  && fail 'database accepted a duplicate (sourceMessageId, kind) task'
case "$DUP_OUT" in
  *'CognitiveTask_sourceMessageId_kind_key'*) pass 'unique (sourceMessageId, kind) enforced by the database' ;;
  *) fail "duplicate insert failed for an unexpected reason: $DUP_OUT" ;;
esac

# 僵尸租约：模拟「进程压在这一条上被杀掉了」。没有注入点能让写停在半路等着被杀，
# 所以这里种的是杀完之后库里必然留下的那种行——RUNNING 且租约已经过期。
# attempts 刻意取 3（=上限）：取 1 的那条会先回 PENDING、再被默认关着的开关作废删掉，
# 两条合起来才同时覆盖「次数用完判死」和「还有次数就回收重跑」这两个出口。
psql "$TEST_DB_PLAIN" -q -v ON_ERROR_STOP=1 -c "
INSERT INTO \"CognitiveTask\"
  (\"id\",\"userId\",\"chatId\",\"sourceMessageId\",\"kind\",\"status\",\"attempts\",\"availableAt\",\"leaseOwner\",\"leaseUntil\",\"updatedAt\")
VALUES
  ('zombie-exhausted','$OWNER_ID','$CHAT_OWNER','$MSG_USER','MEMORY','RUNNING',3,now()-interval '1 minute','worker-killed',now()-interval '5 seconds',now()),
  ('zombie-reclaimable','$OWNER_ID','$CHAT_OWNER','$MSG_ASSIST','MEMORY','RUNNING',1,now()-interval '1 minute','worker-killed',now()-interval '5 seconds',now());" >/dev/null \
  || fail 'could not seed zombie task rows'

ZOMBIE_OK=1
for _ in $(seq 1 40); do
  A=$(psql "$TEST_DB_PLAIN" -Atc "select status || '/' || coalesce(\"lastErrorCode\",'-') from \"CognitiveTask\" where id = 'zombie-exhausted'")
  B=$(psql "$TEST_DB_PLAIN" -Atc "select count(*) from \"CognitiveTask\" where id = 'zombie-reclaimable'")
  if [[ "$A" == "DEAD/LEASE_EXPIRED" && "$B" == "0" ]]; then
    ZOMBIE_OK=0
    break
  fi
  sleep 0.5
done
[[ "$ZOMBIE_OK" == "0" ]] || fail "zombie leases not reclaimed by the worker (exhausted=$A, reclaimable left=$B)"
pass 'expired lease with attempts exhausted is marked DEAD, not resurrected'
pass 'expired lease with attempts left is reclaimed, re-claimed and drained'
grep -E "\"sourceMessageId\":\"$MSG_ASSIST\"" "$SERVER_LOG" >/dev/null \
  || fail 'the reclaimed task was never touched by any worker event'
pass 'the reclaimed task was executed by the live worker'

psql "$TEST_DB_PLAIN" -q -c "DELETE FROM \"CognitiveTask\" WHERE \"id\" LIKE 'zombie-%';" >/dev/null
LEFTOVER=$(psql "$TEST_DB_PLAIN" -Atc "select count(*) from \"CognitiveTask\"")
[[ "$LEFTOVER" == "0" ]] || fail "$LEFTOVER task rows left in the queue after this section"
pass 'the queue holds only outstanding work: finished and voided tasks leave no rows'

# -------------------------------------------------------------------- uploads
section 'Uploads, content inspection, encryption, document extraction and STT'
printf 'integration upload marker SECRET-UPLOAD-42\n' >"$TEST_ROOT/note.txt"
printf 'this is not a png\n' >"$TEST_ROOT/fake.png"
printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lZs7WQAAAABJRU5ErkJggg==' | base64 -d >"$TEST_ROOT/pixel.png"
python3 - "$TEST_ROOT/report.docx" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    z.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    z.writestr('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello from DOCX integration fixture.</w:t></w:r></w:p></w:body></w:document>')
PY
python3 - "$TEST_ROOT/report.pdf" <<'PY'
import sys
objs = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
]
stream = b"BT /F1 14 Tf 30 120 Td (Hello PDF integration fixture.) Tj ET"
objs.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
offsets = [0]
for i, obj in enumerate(objs, 1):
    offsets.append(len(out))
    out += f"{i} 0 obj\n".encode() + obj + b"\nendobj\n"
xref = len(out)
out += f"xref\n0 {len(objs) + 1}\n".encode() + b"0000000000 65535 f \n"
for off in offsets[1:]:
    out += f"{off:010d} 00000 n \n".encode()
out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
open(sys.argv[1], 'wb').write(out)
PY
python3 - "$TEST_ROOT/voice.wav" <<'PY'
import sys, wave
with wave.open(sys.argv[1], 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
    w.writeframes(b'\x00\x00' * 800)
PY

upload_file() {
  local file="$1" name="$2" mime="$3" jar="$4" csrf="$5"
  curl -sS -o "$BODY" -w '%{http_code}' -b "$jar" -H "x-csrf-token: $csrf" \
    -F "file=@$file;filename=$name;type=$mime" -F "chatId=$CHAT_OWNER" "$BASE/api/upload"
}

code=$(upload_file "$TEST_ROOT/pixel.png" '<img src=x onerror=alert(1)>.png' image/png "$JAR_OWNER" "$OWNER_CSRF")
assert_status 200 "$code" 'valid PNG accepted'
ATT_IMG=$(json_val '.data.attachment.id')
assert_jq '.data.attachment.kind == "IMAGE" and (.data.attachment.name | contains("<") | not)' 'XSS filename sanitized'
ATT_NAME=$(json_val '.data.attachment.name')
[[ "$ATT_NAME" != *'<'* && "$ATT_NAME" != *'>'* ]] || fail 'unsafe filename characters survived'

code=$(upload_file "$TEST_ROOT/fake.png" 'fake.png' image/png "$JAR_OWNER" "$OWNER_CSRF")
assert_status 400 "$code" 'fake PNG rejected by magic-byte inspection'
assert_jq '.error.code == "UNKNOWN_FILE_TYPE"' 'fake file returns UNKNOWN_FILE_TYPE'

code=$(upload_file "$TEST_ROOT/note.txt" 'note.txt' text/plain "$JAR_OWNER" "$OWNER_CSRF")
assert_status 200 "$code" 'text upload accepted'
ATT_TXT=$(json_val '.data.attachment.id')
assert_jq '.data.attachment.hasText == true' 'text extracted for context'

code=$(upload_file "$TEST_ROOT/report.docx" 'report.docx' \
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document' "$JAR_OWNER" "$OWNER_CSRF")
assert_status 200 "$code" 'DOCX upload accepted'
ATT_DOCX=$(json_val '.data.attachment.id')
assert_jq '.data.attachment.hasText == true' 'DOCX text extracted'

code=$(upload_file "$TEST_ROOT/report.pdf" 'report.pdf' application/pdf "$JAR_OWNER" "$OWNER_CSRF")
assert_status 200 "$code" 'PDF upload accepted'
ATT_PDF=$(json_val '.data.attachment.id')
assert_jq '.data.attachment.hasText == true' 'PDF text extracted'

curl -sS -b "$JAR_OWNER" -o "$TEST_ROOT/download.txt" "$BASE/api/files/$ATT_TXT"
cmp -s "$TEST_ROOT/download.txt" "$TEST_ROOT/note.txt" || fail 'downloaded file differs from original'
pass 'download decrypts to the exact original bytes'

STORAGE_KEY=$(psql "$TEST_DB_PLAIN" -Atc "select \"storageKey\" from \"Attachment\" where id = '$ATT_TXT'")
[[ "$(head -c 4 "$UPLOAD_DIR/$STORAGE_KEY")" == "FAC1" ]] || fail 'attachment file is not encrypted on disk'
grep -q 'SECRET-UPLOAD-42' "$UPLOAD_DIR/$STORAGE_KEY" && fail 'attachment plaintext found on disk' || true
pass 'attachment is encrypted at rest (FAC1) and contains no plaintext'

code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/files/$ATT_TXT")
assert_status_no_body 401 "$code" 'unauthenticated file download denied'
code=$(api GET "/api/files/$ATT_TXT" "$JAR_MIRA")
assert_status 404 "$code" 'another user cannot read the attachment'

code=$(curl -sS -o "$BODY" -w '%{http_code}' -b "$JAR_OWNER" -H "x-csrf-token: $OWNER_CSRF" \
  -H 'content-type: application/json' --data-binary \
  "$(json_n --arg a1 "$ATT_IMG" --arg a2 "$ATT_TXT" --arg a3 "$ATT_DOCX" --arg a4 "$ATT_PDF" \
    '{content:"summarize attachments",attachmentIds:[$a1,$a2,$a3,$a4]}')" \
  "$BASE/api/chats/$CHAT_OWNER/messages")
assert_status 200 "$code" 'message with image, text, DOCX and PDF succeeds'
grep -q 'MOCK_REPLY: summarize attachments' "$BODY" || fail 'attachment message reply missing'

code=$(curl -sS -o "$BODY" -w '%{http_code}' -b "$JAR_OWNER" -H "x-csrf-token: $OWNER_CSRF" \
  -F "audio=@$TEST_ROOT/voice.wav;type=audio/wav" "$BASE/api/stt")
assert_status 200 "$code" 'speech-to-text endpoint accepts audio'
assert_jq '.data.text == "MOCK_TRANSCRIPT"' 'STT returns provider transcript'

# ------------------------------------------------------------------ isolation
section 'Per-user isolation and privilege boundaries'
code=$(api GET "/api/chats/$CHAT_OWNER" "$JAR_MIRA")
assert_status 404 "$code" 'normal user cannot read owner chat'
code=$(api POST "/api/chats/$CHAT_OWNER/messages" "$JAR_MIRA" \
  '{"content":"intrusion","attachmentIds":[]}' "$MIRA_CSRF")
assert_status 404 "$code" 'normal user cannot post to owner chat'
code=$(api DELETE "/api/chats/$CHAT_OWNER" "$JAR_MIRA" '' "$MIRA_CSRF")
assert_status 404 "$code" 'normal user cannot delete owner chat'

code=$(api POST /api/chats "$JAR_MIRA" '{}' "$MIRA_CSRF")
assert_status 200 "$code" 'normal user creates own chat'
CHAT_MIRA=$(json_val '.data.chat.id')
curl -sS -N -b "$JAR_MIRA" -H "x-csrf-token: $MIRA_CSRF" \
  -H 'content-type: application/json' --data-binary '{"content":"mira says hi","attachmentIds":[]}' \
  "$BASE/api/chats/$CHAT_MIRA/messages" >"$TEST_ROOT/mira-sse.txt"
grep -q 'MOCK_REPLY: mira says hi' "$TEST_ROOT/mira-sse.txt" || fail 'normal user chat failed'
pass 'normal user chat works'
code=$(api GET "/api/chats/$CHAT_MIRA" "$JAR_OWNER")
assert_status 404 "$code" 'owner sees 404 (not 403) for another user chat'

code=$(curl -sS -o /dev/null -w '%{http_code}' -b "$JAR_MIRA" "$BASE/admin")
assert_status_no_body '302 307' "$code" 'normal user /admin redirects away'
code=$(api GET /api/admin/overview "$JAR_MIRA")
assert_status 403 "$code" 'normal user admin API returns 403'
code=$(api PATCH /api/admin/config "$JAR_MIRA" '{"registrationOpen":true}' "$MIRA_CSRF")
assert_status 403 "$code" 'normal user cannot mutate admin config'
code=$(api GET /api/admin/logs/audit "$JAR_MIRA")
assert_status 403 "$code" 'normal user cannot read audit logs'

code=$(api DELETE "/api/admin/users/$OWNER_ID" "$JAR_OWNER" \
  "$(json_n --arg p "$OWNER_PW" '{confirmPassword:$p}')" "$OWNER_CSRF")
assert_status 400 "$code" 'owner account cannot be deleted'
assert_jq '.error.code == "SELF_TARGET"' 'self-deletion returns SELF_TARGET'
code=$(api PATCH "/api/admin/users/$OWNER_ID" "$JAR_OWNER" \
  "$(json_n --arg p "$OWNER_PW" '{action:"resetPassword",confirmPassword:$p}')" "$OWNER_CSRF")
assert_status 403 "$code" 'owner password cannot be reset by the generic admin path'

# fake session token
curl -sS -o /dev/null -w '%{http_code}' -b 'fac_session=forged-session-token-value-1234567890' \
  "$BASE/api/auth/me" >"$TEST_ROOT/forged.code"
code=$(cat "$TEST_ROOT/forged.code")
assert_status_no_body 401 "$code" 'forged session cookie is rejected'

# ---------------------------------------------------------------- admin users
section 'Admin user lifecycle, password security and sessions'
code=$(api POST /api/admin/users "$JAR_OWNER" \
  "$(json_n --arg p "$OWNER_PW" '{username:"tester",email:"tester@test.local",confirmPassword:$p}')" \
  "$OWNER_CSRF")
assert_status 200 "$code" 'owner creates a managed user'
TESTER_ID=$(json_val '.data.user.id')
TESTER_PW=$(json_val '.data.temporaryPassword')
[[ -n "$TESTER_PW" && "$TESTER_PW" != 'null' ]] || fail 'no one-time temporary password returned'

HASH=$(psql "$TEST_DB_PLAIN" -Atc "select \"passwordHash\" from \"User\" where id = '$TESTER_ID'")
[[ "$HASH" == '$argon2id$'* ]] || fail 'password hash is not Argon2id'
pass 'managed user password hash uses Argon2id'

code=$(api POST /api/auth/login "$JAR_TESTER" \
  "$(json_n --arg u tester --arg p "$TESTER_PW" '{identifier:$u,password:$p}')")
assert_status 200 "$code" 'temporary password logs in'
code=$(api PATCH "/api/admin/users/$TESTER_ID" "$JAR_OWNER" \
  "$(json_n --arg p "$OWNER_PW" '{action:"resetPassword",confirmPassword:$p}')" "$OWNER_CSRF")
assert_status 200 "$code" 'admin reset password succeeds'
TESTER_PW2=$(json_val '.data.temporaryPassword')
code=$(api GET /api/auth/me "$JAR_TESTER")
assert_status 401 "$code" 'password reset revokes existing sessions'
code=$(api POST /api/auth/login "$JAR_TESTER" \
  "$(json_n --arg u tester --arg p "$TESTER_PW2" '{identifier:$u,password:$p}')")
assert_status 200 "$code" 'new temporary password logs in'

code=$(api PATCH "/api/admin/users/$TESTER_ID" "$JAR_OWNER" \
  "$(json_n --arg p "$OWNER_PW" '{action:"setStatus",status:"DISABLED",confirmPassword:$p}')" "$OWNER_CSRF")
assert_status 200 "$code" 'admin disables a user'
code=$(api GET /api/auth/me "$JAR_TESTER")
assert_status 401 "$code" 'disabling immediately invalidates sessions'
code=$(api POST /api/auth/login "$JAR_TESTER" \
  "$(json_n --arg u tester --arg p "$TESTER_PW2" '{identifier:$u,password:$p}')")
assert_status 403 "$code" 'disabled user cannot log in'
code=$(api PATCH "/api/admin/users/$TESTER_ID" "$JAR_OWNER" \
  "$(json_n --arg p "$OWNER_PW" '{action:"setStatus",status:"ACTIVE",confirmPassword:$p}')" "$OWNER_CSRF")
assert_status 200 "$code" 'admin re-enables the user'
code=$(api POST /api/auth/login "$JAR_TESTER" \
  "$(json_n --arg u tester --arg p "$TESTER_PW2" '{identifier:$u,password:$p}')")
assert_status 200 "$code" 're-enabled user can log in'

code=$(api PATCH "/api/admin/users/$TESTER_ID" "$JAR_OWNER" \
  "$(json_n --arg p "$OWNER_PW" '{action:"setEmail",email:"tester2@test.local",confirmPassword:$p}')" "$OWNER_CSRF")
assert_status 200 "$code" 'admin changes user email'
assert_jq '.data.user.email == "tester2@test.local"' 'email change persisted'

code=$(api DELETE "/api/admin/users/$TESTER_ID" "$JAR_OWNER" \
  "$(json_n --arg p "$OWNER_PW" '{confirmPassword:$p}')" "$OWNER_CSRF")
assert_status 200 "$code" 'admin deletes managed user'
code=$(api POST /api/auth/login "$JAR_EMPTY" \
  "$(json_n --arg u tester --arg p "$TESTER_PW2" '{identifier:$u,password:$p}')")
assert_status 401 "$code" 'deleted user cannot log in'

# ------------------------------------------------------ account and sessions
section 'Account settings, password change, email change and password reset'
code=$(api PATCH /api/account "$JAR_MIRA" '{"displayName":"Mira Test"}' "$MIRA_CSRF")
assert_status 200 "$code" 'profile display name updates'
assert_jq '.data.user.displayName == "Mira Test"' 'display name persisted'

curl -sS -c "$JAR_MIRA2" -b "$JAR_MIRA2" -o /dev/null -X POST \
  -H 'content-type: application/json' \
  --data-binary "$(json_n --arg u mira --arg p "$MIRA_PW" '{identifier:$u,password:$p}')" \
  "$BASE/api/auth/login"
code=$(api GET /api/account/sessions "$JAR_MIRA")
assert_status 200 "$code" 'session list available'
assert_jq '.data.sessions | length >= 2' 'multiple active sessions listed'
OTHER_SESSION=$(json_val '.data.sessions[] | select(.current == false) | .id' | head -n 1)
code=$(api DELETE "/api/account/sessions/$OTHER_SESSION" "$JAR_MIRA" '' "$MIRA_CSRF")
assert_status 200 "$code" 'other session can be revoked'
code=$(api GET /api/auth/me "$JAR_MIRA2")
assert_status 401 "$code" 'revoked session is rejected'

MIRA_CSRF=$(csrf_of "$JAR_MIRA")
code=$(api POST /api/account/password "$JAR_MIRA" \
  "$(json_n --arg c "$MIRA_PW" --arg n "$MIRA_PW2" '{currentPassword:$c,newPassword:$n}')" "$MIRA_CSRF")
assert_status 200 "$code" 'user changes own password'
code=$(api POST /api/auth/login "$JAR_EMPTY" \
  "$(json_n --arg u mira --arg p "$MIRA_PW" '{identifier:$u,password:$p}')")
assert_status 401 "$code" 'old password no longer works'

code=$(api POST /api/account/email/request "$JAR_MIRA" \
  "$(json_n --arg e 'mira2@test.local' --arg p "$MIRA_PW2" '{newEmail:$e,password:$p}')" "$MIRA_CSRF")
assert_status 200 "$code" 'email change code requested'
EMAIL_CODE=$(last_email_code)
code=$(api POST /api/account/email/verify "$JAR_MIRA" \
  "$(json_n --arg e 'mira2@test.local' --arg c "$EMAIL_CODE" '{newEmail:$e,code:$c}')" "$MIRA_CSRF")
assert_status 200 "$code" 'email change verified'
assert_jq '.data.user.email == "mira2@test.local"' 'new email persisted'
MIRA_EMAIL='mira2@test.local'

code=$(api POST /api/auth/password/forgot "$JAR_EMPTY" "$(json_n --arg e "$MIRA_EMAIL" '{email:$e}')")
assert_status 200 "$code" 'forgot-password request accepted'
RESET_CODE=$(last_email_code)
code=$(api POST /api/auth/password/reset "$JAR_EMPTY" \
  "$(json_n --arg e "$MIRA_EMAIL" --arg c "$RESET_CODE" --arg p "$MIRA_PW3" '{email:$e,code:$c,password:$p}')")
assert_status 200 "$code" 'password reset completes'
code=$(api GET /api/auth/me "$JAR_MIRA")
assert_status 401 "$code" 'password reset revokes all sessions'
code=$(api POST /api/auth/login "$JAR_MIRA" \
  "$(json_n --arg u mira --arg p "$MIRA_PW3" '{identifier:$u,password:$p}')")
assert_status 200 "$code" 'login with reset password works'
MIRA_CSRF=$(csrf_of "$JAR_MIRA")

# -------------------------------------------------------------- IP allowlist
section 'Dynamic IP whitelist, expiry and lockout protection'
code=$(api GET /api/admin/ip-rules "$JAR_OWNER")
assert_status 200 "$code" 'IP rules listed'
assert_jq '.data.currentIp == "127.0.0.1"' 'current public/client IP reported'
LOOPBACK_RULE=$(json_val '.data.rules[] | select(.cidr == "127.0.0.1/32") | .id' | head -n 1)

code=$(api PATCH "/api/admin/ip-rules/$LOOPBACK_RULE" "$JAR_OWNER" \
  "$(json_n --arg p "$OWNER_PW" '{enabled:false,confirmPassword:$p}')" "$OWNER_CSRF")
assert_status 409 "$code" 'disabling the last covering rule is refused'
assert_jq '.error.code == "LOCKOUT_RISK"' 'lockout-risk code returned'

code=$(api POST /api/admin/ip-rules "$JAR_OWNER" \
  "$(json_n --arg p "$OWNER_PW" '{cidr:"127.0.0.2/32",label:"integration allow",enabled:true,confirmPassword:$p}')" \
  "$OWNER_CSRF")
assert_status 200 "$code" 'add allowlist rule at runtime'
RULE_2=$(json_val '.data.rule.id')

EXPIRES=$(date -u -d '+3 seconds' +%Y-%m-%dT%H:%M:%SZ)
code=$(api POST /api/admin/ip-rules "$JAR_OWNER" \
  "$(json_n --arg p "$OWNER_PW" --arg e "$EXPIRES" '{cidr:"127.0.0.3/32",label:"temporary",enabled:true,expiresAt:$e,confirmPassword:$p}')" \
  "$OWNER_CSRF")
assert_status 200 "$code" 'add temporary allowlist rule'
RULE_3=$(json_val '.data.rule.id')

sleep 1.2
code=$(curl --interface 127.0.0.2 -sS -o /dev/null -w '%{http_code}' "$BASE/api/health")
assert_status_no_body 200 "$code" 'new rule takes effect without restart'
code=$(curl --interface 127.0.0.3 -sS -o /dev/null -w '%{http_code}' "$BASE/api/health")
assert_status_no_body 200 "$code" 'temporary rule is active before expiry'

sleep 3.5
code=$(curl --interface 127.0.0.3 -sS -o /dev/null -w '%{http_code}' "$BASE/api/health")
assert_status_no_body 403 "$code" 'expired temporary rule is enforced'

code=$(api POST /api/admin/ip-rules "$JAR_OWNER" \
  "$(json_n --arg p "$OWNER_PW" --arg cidr '127.0.0.1/99' '{cidr:$cidr,label:"invalid",enabled:true,confirmPassword:$p}')" \
  "$OWNER_CSRF")
assert_status 400 "$code" 'invalid CIDR is rejected'
assert_jq '.error.code == "INVALID_CIDR" or .error.code == "VALIDATION_ERROR"' 'invalid CIDR error code'

code=$(api DELETE "/api/admin/ip-rules/$RULE_3" "$JAR_OWNER" \
  "$(json_n --arg p "$OWNER_PW" '{confirmPassword:$p}')" "$OWNER_CSRF")
assert_status 200 "$code" 'temporary rule deleted'
code=$(api DELETE "/api/admin/ip-rules/$RULE_2" "$JAR_OWNER" \
  "$(json_n --arg p "$OWNER_PW" '{confirmPassword:$p}')" "$OWNER_CSRF")
assert_status 200 "$code" 'runtime allowlist rule deleted'
sleep 1.2
code=$(curl --interface 127.0.0.2 -sS -o /dev/null -w '%{http_code}' "$BASE/api/health")
assert_status_no_body 403 "$code" 'deletion is effective immediately'

code=$(api GET /api/admin/logs/login "$JAR_OWNER")
assert_status 200 "$code" 'login logs readable by owner'
assert_jq '.data.items | any(.success == false)' 'failed login attempts recorded'
code=$(api GET /api/admin/logs/access "$JAR_OWNER")
assert_status 200 "$code" 'IP access logs readable by owner'
assert_jq '.data.items | any(.ip == "127.0.0.2" and .allowed == false)' 'denied access logged with IP/path'
code=$(api GET /api/admin/logs/audit "$JAR_OWNER")
assert_status 200 "$code" 'audit logs readable by owner'
assert_jq '.data.items | any(.action == "admin.ip_rule.create")' 'IP rule change audited'
grep -q "$API_KEY" "$BODY" && fail 'audit logs leaked a plaintext API key' || true
pass 'audit logs do not contain the API key'

# ------------------------------------------------------------- backup/restore
section 'Encrypted backup, download integrity and restore into a separate DB'
code=$(api POST /api/admin/backups "$JAR_OWNER" \
  "$(json_n --arg p "$OWNER_PW" '{confirmPassword:$p}')" "$OWNER_CSRF")
assert_status 200 "$code" 'encrypted backup created'
BACKUP_FILE=$(json_val '.data.backup.file')
BACKUP_SHA=$(json_val '.data.backup.sha256')
BACKUP_PATH="$BACKUP_DIR/$BACKUP_FILE"
[[ -f "$BACKUP_PATH" ]] || fail 'backup file missing'
[[ "$(head -c 10 "$BACKUP_PATH")" == "FACBACKUP1" ]] || fail 'backup does not start with FACBACKUP1'
pass 'backup uses FACBACKUP1 magic'

grep -q 'hello integration' "$BACKUP_PATH" && fail 'backup contains plaintext chat content' || true
grep -q "$API_KEY" "$BACKUP_PATH" && fail 'backup contains plaintext API key' || true
pass 'backup does not contain plaintext messages or keys'

code=$(download_api '/api/admin/backups/download' "$JAR_OWNER" \
  "$(json_n --arg f "$BACKUP_FILE" --arg p "$OWNER_PW" '{file:$f,confirmPassword:$p}')" \
  "$OWNER_CSRF" "$TEST_ROOT/downloaded.facbackup")
assert_status 200 "$code" 'backup download succeeds'
ACTUAL_SHA=$(sha256sum "$TEST_ROOT/downloaded.facbackup" | cut -d' ' -f1)
[[ "$ACTUAL_SHA" == "$BACKUP_SHA" ]] || fail 'downloaded backup hash mismatch'
pass 'downloaded backup matches recorded SHA-256'

psql "$DB_PREFIX/postgres" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS \"$RESTORE_DB\" WITH (FORCE);"
psql "$DB_PREFIX/postgres" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"$RESTORE_DB\";"
env DATABASE_URL="$RESTORE_DB_URL" UPLOAD_DIR="$UPLOAD_DIR" BACKUP_DIR="$TEST_ROOT/restore-backups" \
  node scripts/restore.mjs "$BACKUP_PATH" --yes --skip-pre-backup --db-only \
  >"$TEST_ROOT/restore.log" 2>&1
RESTORED_USERS=$(psql "$RESTORE_DB_PLAIN" -Atc 'select count(*) from "User";')
RESTORED_MESSAGES=$(psql "$RESTORE_DB_PLAIN" -Atc 'select count(*) from "Message";')
RESTORED_OWNER=$(psql "$RESTORE_DB_PLAIN" -Atc "select count(*) from \"User\" where username = 'owner' and role = 'OWNER';")
[[ "$RESTORED_USERS" -ge 2 && "$RESTORED_MESSAGES" -ge 2 && "$RESTORED_OWNER" -eq 1 ]] || \
  fail "restore verification failed (users=$RESTORED_USERS messages=$RESTORED_MESSAGES owner=$RESTORED_OWNER)"
pass 'restore into separate DB preserves users, owner and messages'

cp "$BACKUP_PATH" "$TEST_ROOT/tampered.facbackup"
python3 - "$TEST_ROOT/tampered.facbackup" <<'PY'
import sys
p = sys.argv[1]
data = bytearray(open(p, 'rb').read())
data[-1] ^= 1
open(p, 'wb').write(data)
PY
if env DATABASE_URL="$RESTORE_DB_URL" UPLOAD_DIR="$UPLOAD_DIR" BACKUP_DIR="$TEST_ROOT/restore-backups" \
  node scripts/restore.mjs "$TEST_ROOT/tampered.facbackup" --yes --skip-pre-backup --db-only \
  >"$TEST_ROOT/restore-tampered.log" 2>&1; then
  fail 'tampered backup was accepted'
fi
pass 'tampered backup rejected (GCM authentication)'

# ---------------------------------------------------------------------- HTTPS
section 'HTTPS/TLS, HSTS and secure cookies'
# openssl 现在开头那份工具预检已经保证在 PATH 上了，这个 else 分支走不到。
# 留着不动是有理由的：它标出这一节真正的边界——那 60 行 TLS 断言要的是自签证书，
# 少了 openssl 就只能整节跳过，而不是退化成一条更弱的断言。
if command -v openssl >/dev/null 2>&1; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
    -keyout "$TEST_ROOT/tls-key.pem" -out "$TEST_ROOT/tls-cert.pem" \
    -subj '/CN=127.0.0.1' >/dev/null 2>&1
  env \
    DATABASE_URL="$TEST_DB_URL" PORT="$TLS_PORT" HOST=0.0.0.0 APP_URL="$TLS_BASE" \
    NODE_ENV=production COOKIE_SECURE=true UPLOAD_DIR="$UPLOAD_DIR" BACKUP_DIR="$BACKUP_DIR" \
    EMAIL_TRANSPORT=console ALLOW_PRIVATE_AI_URLS=true IP_CACHE_MS=250 \
    TRUST_PROXY=true TRUSTED_PROXY_CIDRS='127.0.0.1/32,::1/128' LOG_LEVEL=warn \
    TLS_KEY_FILE="$TEST_ROOT/tls-key.pem" TLS_CERT_FILE="$TEST_ROOT/tls-cert.pem" \
    nohup node server.js >"$TLS_LOG" 2>&1 &
  TLS_SERVER_PID=$!
  wait_for_health "$TLS_BASE/api/health" "$TLS_LOG" || fail 'TLS server did not become healthy'

  code=$(curl -sk --tlsv1.2 --tls-max 1.2 -o /dev/null -w '%{http_code}' "$TLS_BASE/api/health")
  assert_status_no_body 200 "$code" 'TLS 1.2 connection works'
  code=$(curl -sk --tlsv1.3 -o /dev/null -w '%{http_code}' "$TLS_BASE/api/health")
  assert_status_no_body 200 "$code" 'TLS 1.3 connection works'

  curl -sk -D "$TEST_ROOT/tls-headers.txt" -o /dev/null "$TLS_BASE/api/health"
  grep -qi '^strict-transport-security: max-age=' "$TEST_ROOT/tls-headers.txt" || fail 'HSTS header missing'
  pass 'HSTS header present'

  curl -sk -c "$JAR_TLS" -D "$TEST_ROOT/tls-login-headers.txt" -o /dev/null \
    -H 'content-type: application/json' \
    --data-binary "$(json_n --arg u owner --arg p "$OWNER_PW" '{identifier:$u,password:$p}')" \
    "$TLS_BASE/api/auth/login"
  grep -qi 'set-cookie: fac_session=.*;.*secure' "$TEST_ROOT/tls-login-headers.txt" || fail 'session cookie is not Secure over TLS'
  grep -qi 'set-cookie: fac_csrf=.*;.*secure' "$TEST_ROOT/tls-login-headers.txt" || fail 'CSRF cookie is not Secure over TLS'
  pass 'session and CSRF cookies are Secure under HTTPS'

  kill "$TLS_SERVER_PID" 2>/dev/null || true
  wait "$TLS_SERVER_PID" 2>/dev/null || true
  TLS_SERVER_PID=""
else
  echo '  ! openssl missing; skipped TLS checks' >&2
fi

# ----------------------------------------------------------- key rotation
section 'Master key rotation'
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

env DATABASE_URL="$TEST_DB_URL" UPLOAD_DIR="$UPLOAD_DIR" BACKUP_DIR="$BACKUP_DIR" \
  npm run rotate-keys -- --new-key-id it2 >"$TEST_ROOT/rotate.log" 2>&1
grep -q 'rotated .* chats' "$TEST_ROOT/rotate.log" || fail 'key rotation did not report rotated records'
pass 'master key rotated on test data'

python3 - "$TEST_ROOT/rotate.log" "$TEST_ROOT/rotate.env" <<'PY'
import json, os, re, sys
text = open(sys.argv[1]).read()
kid = re.search(r'^MASTER_KEY_ID=(.+)$', text, re.M).group(1).strip()
key = re.search(r'^MASTER_KEY=(.+)$', text, re.M).group(1).strip()
ring = re.search(r'^MASTER_KEYRING=(.+)$', text, re.M).group(1).strip()
json.loads(ring)
fd = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, (f"export MASTER_KEY_ID={kid}\nexport MASTER_KEY={key}\nexport MASTER_KEYRING='{ring}'\n").encode())
os.close(fd)
PY

KEYS_LEFT=$(psql "$TEST_DB_PLAIN" -Atc "select count(*) from \"Chat\" where \"titleCiphertext\" not like 'enc:v1:it2:%';")
[[ "$KEYS_LEFT" -eq 0 ]] || fail 'some chat titles were not rotated'
STORAGE_KEY=$(psql "$TEST_DB_PLAIN" -Atc "select \"storageKey\" from \"Attachment\" where id = '$ATT_TXT'")
[[ "$(head -c 4 "$UPLOAD_DIR/$STORAGE_KEY")" == "FAC1" ]] || fail 'attachment lost FAC1 header after rotation'
pass 'database ciphertexts and attachment header migrated to the new key id'

set -a
# shellcheck disable=SC1090
. "$TEST_ROOT/rotate.env"
set +a
env \
  DATABASE_URL="$TEST_DB_URL" PORT="$PORT" HOST=0.0.0.0 APP_URL="$BASE" \
  NODE_ENV=production ALLOW_INSECURE_COOKIES=true COOKIE_SECURE=false \
  UPLOAD_DIR="$UPLOAD_DIR" BACKUP_DIR="$BACKUP_DIR" EMAIL_TRANSPORT=console \
  ALLOW_PRIVATE_AI_URLS=true IP_CACHE_MS=250 TRUST_PROXY=true \
  TRUSTED_PROXY_CIDRS='127.0.0.1/32,::1/128' LOG_LEVEL=warn \
  nohup node server.js >"$TEST_ROOT/server-after-rotate.log" 2>&1 &
SERVER_PID=$!
wait_for_health "$BASE/api/health" "$TEST_ROOT/server-after-rotate.log" || fail 'server failed after rotation'
code=$(api GET "/api/chats/$CHAT_OWNER" "$JAR_OWNER")
assert_status 200 "$code" 'chat decrypts after master key rotation'
assert_jq '.data.chat.messages[1].content | contains("MOCK_REPLY")' 'messages decrypt with rotated key'
curl -sS -b "$JAR_OWNER" -o "$TEST_ROOT/download-rotated.txt" "$BASE/api/files/$ATT_TXT"
cmp -s "$TEST_ROOT/download-rotated.txt" "$TEST_ROOT/note.txt" || fail 'attachment does not decrypt after rotation'
pass 'attachments decrypt after master key rotation'

# ------------------------------------------------------------------- summary
section "RESULT: $PASS checks passed, 0 failed"
printf 'Artifacts: %s\n' "$TEST_ROOT"
