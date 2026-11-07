# API 参考

本文件是接口的事实来源。路径、方法、鉴权与响应形状都从 `src/app/api/**/route.ts`
与 `src/lib/http.ts` 抄下来；请求体字段来自 `src/lib/validation.ts` 的 schema。
行为细则（为什么这样判、闸门在哪一层）见 [ARCHITECTURE.md](ARCHITECTURE.md) 与
[cognitive-acceptance.md](cognitive-acceptance.md)。

## 约定

### 响应信封

成功：

```json
{ "ok": true, "data": { } }
```

失败：

```json
{ "ok": false, "error": { "code": "MODULE_DISABLED", "message": "…", "details": null } }
```

所有 API 响应带 `Cache-Control: no-store`。错误响应不返回堆栈。

### 鉴权

| 层 | 要求 |
|---|---|
| 会话 | `fac_session` Cookie（HttpOnly）；除下表标「公开」的端点外都要求 |
| CSRF | 所有变更请求（POST/PATCH/PUT/DELETE）带 `x-csrf-token`，值与 `fac_csrf` Cookie 相同；存在 `Origin` 时还要求同源 |
| 管理员 | `/api/admin/**` 与 `/api/admin/providers/**` 要求 `OWNER` 角色 |
| 二次验证 | 管理员敏感写操作额外要求当前管理员密码（前端 Reauth 对话框） |
| 用户归属 | 一律从会话取 `userId`；路由不接受请求体/查询串里的 `userId` |

公开端点：`POST /api/auth/login`、`POST /api/auth/logout`、`POST /api/auth/password/forgot`、
`POST /api/auth/password/reset`、`POST /api/auth/register/request`、
`POST /api/auth/register/verify`、`GET /api/health`。其余全部要求会话。

### 错误码

| HTTP | code | 含义 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | 参数不符合 schema；`details[]` 带 `path` / `message` |
| 400 | `WEAK_PASSWORD` | 新密码不满足策略 |
| 401 | `UNAUTHENTICATED` | 无会话或会话已失效 |
| 403 | `FORBIDDEN` | 权限不足、越权访问、跨用户资源 |
| 404 | `NOT_FOUND` | 资源不存在或不属于当前用户（跨用户统一 404） |
| 409 | `MODULE_DISABLED` | 对应认知模块关着；`message` 说明去哪一屏打开 |
| 409 | 其他 | 状态机冲突（如重复确认、非法转移） |
| 413 | `PAYLOAD_TOO_LARGE` | 上传/请求体超限 |
| 429 | `RATE_LIMITED` | 触发限流 |
| 502/503 | `EMBEDDING_FAILED` / `NO_EMBEDDING_MODEL` 等 | 上游能力不可用 |

### 限流（进程内，按用户或 IP）

| 端点 | 额度 |
|---|---|
| 登录 | IP 20 次 / 15 分钟；同一 identifier 8 次 / 15 分钟 |
| 注册 / 找回 | 另有 IP 与邮箱维度 |
| `POST /api/upload` | 120 次 / 分钟 / 用户，另有并发闸 |
| `GET /api/files/[id]` | 600 次 / 分钟 / 用户 |
| `POST /api/stt` | 12 次 / 分钟 / 用户 |

## 路由总表

### 认证

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| POST | `/api/auth/login` | 公开 | 用户名/邮箱 + 密码登录，写会话 Cookie |
| POST | `/api/auth/logout` | 公开 | 撤销当前会话 |
| GET | `/api/auth/me` | 会话 | 当前用户与 CSRF token |
| POST | `/api/auth/password/forgot` | 公开 | 发重置验证码 |
| POST | `/api/auth/password/reset` | 公开 | 用验证码重置密码 |
| POST | `/api/auth/register/request` | 公开 | 注册验证码 |
| POST | `/api/auth/register/verify` | 公开 | 验证并创建账号 |

### 账号

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| GET / PATCH | `/api/account` | 会话 | 读取资料 / 改名改邮箱 |
| POST | `/api/account/password` | 会话 | 改密码（撤销其他会话） |
| POST | `/api/account/email/request` | 会话 | 邮箱变更验证码 |
| POST | `/api/account/email/verify` | 会话 | 确认邮箱变更 |
| GET / POST | `/api/account/sessions` | 会话 | 会话列表 / 撤销其他会话 |
| DELETE | `/api/account/sessions/[id]` | 会话 | 撤销指定会话 |
| GET / POST / PATCH / PUT / DELETE | `/api/account/providers` | 会话 | 用户自有 AI Provider 的增删改查 |
| POST | `/api/account/providers/test` | 会话 | 测试 Provider 连通性（不返回 Key） |
| GET | `/api/account/attachments` | 会话 | 附件列表 |

### 聊天

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| GET / POST | `/api/chats` | 会话 | 会话列表 / 新建 |
| GET / PATCH / DELETE | `/api/chats/[id]` | 会话 | 读取（含消息）/ 重命名 / 删除 |
| POST | `/api/chats/[id]/messages` | 会话 | 发送消息，返回 SSE 流 |
| PATCH | `/api/chats/[id]/model` | 会话 | 切换本会话模型 |

### 上传、文件、语音

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| POST | `/api/upload` | 会话 | multipart 上传（图片 / PDF / DOCX / 文本 / 音频） |
| GET / DELETE | `/api/files/[id]` | 会话 | 解密下载 / 删除未入消息的附件 |
| POST | `/api/stt` | 会话 | 语音转写 |
| GET | `/api/health` | 公开 | 存活与数据库状态 |

### 管理后台

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| GET | `/api/admin/overview` | OWNER | 概览计数 |
| GET / POST | `/api/admin/users` | OWNER + 二次验证 | 用户列表 / 新建 |
| PATCH / DELETE | `/api/admin/users/[id]` | OWNER + 二次验证 | 修改 / 删除用户 |
| GET / POST | `/api/admin/ip-rules` | OWNER + 二次验证 | IP 规则列表 / 新建 |
| PATCH / DELETE | `/api/admin/ip-rules/[id]` | OWNER + 二次验证 | 修改 / 删除规则 |
| GET / DELETE | `/api/admin/login-locks` | OWNER | 查看登录锁定 / 解锁 |
| GET / PATCH | `/api/admin/config` | OWNER + 二次验证 | 读取 / 修改站点配置 |
| GET / POST | `/api/admin/providers` | OWNER + 二次验证 | 平台 Provider 列表 / 新建 |
| PATCH / DELETE | `/api/admin/providers/[id]` | OWNER + 二次验证 | 修改 / 删除 |
| POST | `/api/admin/providers/[id]/test` | OWNER | 测试平台 Provider |
| GET | `/api/admin/logs/access`、`/api/admin/logs/audit`、`/api/admin/logs/login` | OWNER | 三类日志 |
| GET / POST | `/api/admin/backups` | OWNER | 备份列表 / 触发备份 |
| POST | `/api/admin/backups/download` | OWNER | 下载备份（要求口令校验） |
| GET | `/api/admin/service` | OWNER | 服务状态 |
| GET / POST | `/api/admin/storage` | OWNER | 存储统计 / 清理 |

## 认知层 API

所有认知端点都要求会话；`userId` 只来自会话。

### 开关与策略

| 方法 | 路径 | 读 / 写 | 说明 |
|---|---|---|---|
| GET | `/api/account/cognitive` | 读 | `{ preferences }`：八个开关 + `emotionTransparency` + `reflectionCooldown` + `memoryWritePaused` + `memoryReadLimit` + `timezoneOffsetMinutes` |
| PATCH | `/api/account/cognitive` | 写 | 请求体为 `cognitivePreferencesPatchSchema` 的任意子集（见下），返回 `{ preferences }` |
| GET | `/api/account/cognitive/policies` | 读 | `{ policies, learning, learningThreshold, learningWindowDays }` |
| PATCH | `/api/account/cognitive/policies` | 写 | `{ context, patch }`；`patch` 全字段可选，未提交的保持原值 |
| DELETE | `/api/account/cognitive/policies?context=` | 写 | 重置该情境为内置默认，返回 `{ policy }` |

`PATCH /api/account/cognitive` 可提交的键（全部可选）：

```text
memoryEnabled, userModelEnabled, emotionEnabled, associationEnabled,
timelineEnabled, reflectionEnabled, decisionMemoryEnabled, adaptiveMemoryEnabled,
emotionTransparency(off|implicit|explicit), reflectionCooldown(daily|weekly|monthly),
memoryWritePaused, memoryReadLimit(1..8，默认 8), timezoneOffsetMinutes(-840..840，浏览器自动同步)
```

`context` 词表：`general`、`technicalProject`、`learning`、`personalGoal`、
`personalReflection`、`emotionalSupport`、`decisionMaking`。

`patch` 可提交：`allowPersistence`、`allowedMemoryTypes[]`（fact / preference / goal /
project / decision / emotion，最多 6 个）、`requireConfirmation`、
`retention`（forever / untilSuperseded / days30 / days90 / sessionOnly）、
`allowUserProfile`、`allowReflection`、`allowAssociation`。

### 记忆

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/account/cognitive/memories` | 当前记忆 + 已归档 + 会话标题 + 置信度 + 复查提示 + 访问统计 |
| DELETE | `/api/account/cognitive/memories?scope=all\|chat\|context&…` | 批量永久删除，返回 `{ purged, learned }` |
| GET | `/api/account/cognitive/memories/[id]` | `{ memory, revisions }` |
| PATCH | `/api/account/cognitive/memories/[id]` | 用户亲手改记忆：`{ content, reason }`（两者必填），返回 `{ memory }` |
| DELETE | `/api/account/cognitive/memories/[id]` | 永久删除一条，返回 `{ purged, learned }` |
| POST | `/api/account/cognitive/memories/[id]/archive` | 归档，返回 `{ archived: true }` |
| POST | `/api/account/cognitive/memories/[id]/restore` | 取消归档，返回 `{ restored: true }` |
| POST | `/api/account/cognitive/memories/[id]/retract` | 撤回：`{ reason }`，返回 `{ retracted: true }` |
| GET | `/api/account/cognitive/memories/[id]/evidence` | `{ evidence }` |
| GET | `/api/account/cognitive/candidates?status=` | 待确认候选；`status` 为 pending / confirmed / rejected |
| PATCH | `/api/account/cognitive/candidates/[id]` | `{ action: 'confirm' }` → `{ memory }`；`{ action: 'reject' }` → `{ rejected, context, learned }` |

记忆列表响应键：`memories`、`archived`、`capped`、`archivedCapped`、`chats`、
`confidence`、`reviews`、`access`、`accessWindow`、`accessCapped`。
这一屏**不受 `memoryEnabled` 拦截**（片L 的裁决）：关掉长期记忆后仍要能看见并清理已有行；
但关着时不会有新的写入。

### 时间线、变化、图谱

| 方法 | 路径 | 闸门 | 说明 |
|---|---|---|---|
| GET | `/api/account/cognitive/timeline` | `timelineEnabled` + `memoryEnabled` | `{ events, chats, capped }`；关着返回 409 `MODULE_DISABLED` |
| GET | `/api/account/cognitive/changes` | 同上 | `{ observations, insufficient, sources, capped }` |
| GET | `/api/account/cognitive/graph` | `associationEnabled` + `memoryEnabled` | 图节点/边 + `chats`；边含 `MemoryRelation` 的关系边（`kind: 'relation'`）与三种派生边；任一关着返回 409 |

### 洞察

| 方法 | 路径 | 闸门 | 说明 |
|---|---|---|---|
| GET | `/api/account/cognitive/reflections?state=` | `reflectionEnabled` | `{ reflections, capped }`；`state` 取六态之一 |
| GET | `/api/account/cognitive/reflections/[id]` | `reflectionEnabled` + `memoryEnabled` | 单条详情与证据；证据就是记忆原文，所以多一道记忆闸门 |
| PATCH | `/api/account/cognitive/reflections/[id]` | `reflectionEnabled` | 动作：`accept` / `reject` / `edit{title,body}` / `snooze{days:3\|7\|30}` |

### 决策

| 方法 | 路径 | 闸门 | 说明 |
|---|---|---|---|
| GET | `/api/account/decisions?status=` | `decisionMemoryEnabled` | `{ decisions, capped }`；`status` 取五态之一 |
| GET | `/api/account/decisions/[id]` | 同上 | 单条决策 + 结果 |
| PATCH | `/api/account/decisions/[id]` | 同上 | `{ action: 'confirm' \| 'reject' }` |
| PATCH | `/api/account/decisions/[id]/outcomes/[outcomeId]` | 同上 | `{ action: 'link' \| 'detach' }` |

### 画像

| 方法 | 路径 | 闸门 | 说明 |
|---|---|---|---|
| GET | `/api/account/cognitive/profile` | `userModelEnabled` | `{ entries, entriesCapped, candidates }` |
| POST | `/api/account/cognitive/profile` | 同上 | `{ content, sourceMemoryIds?[], sourceReflectionIds?[] }`；确认时间由服务端盖章 |
| DELETE | `/api/account/cognitive/profile` | 同上 | 清空全部画像条目（不随「清空长期记忆」发生） |
| PATCH | `/api/account/cognitive/profile/[id]` | 同上 | 只改正文 `{ content }` |
| DELETE | `/api/account/cognitive/profile/[id]` | 同上 | 删除一条 |

### 门厅、失败任务、排除规则

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/account/cognitive/overview` | 门厅：七块模块的「开没开 + 有多少」；**关着也返回 200**，只把该块标成未打开，不读内容 |
| GET | `/api/account/cognitive/failed-tasks` | 失败/死信的认知任务（只读，不解密） |
| GET | `/api/account/cognitive/exclusions` | `{ exclusions }`：来源排除规则 |
| DELETE | `/api/account/cognitive/exclusions/[id]` | 撤销一条排除，返回 `{ removed: true }` |

## 请求示例

```bash
# 读认知开关（Cookie 由登录获得）
curl -sS https://chat.example.com/api/account/cognitive \
  -H 'Cookie: fac_session=…; fac_csrf=…'

# 改一个开关（变更请求必须带 CSRF）
curl -sS -X PATCH https://chat.example.com/api/account/cognitive \
  -H 'Content-Type: application/json' \
  -H 'Cookie: fac_session=…; fac_csrf=…' \
  -H 'x-csrf-token: …' \
  -d '{"memoryEnabled":true}'

# 按主题忘记
curl -sS -X DELETE \
  'https://chat.example.com/api/account/cognitive/memories?scope=context&context=technicalProject' \
  -H 'Cookie: fac_session=…; fac_csrf=…' \
  -H 'x-csrf-token: …'
```

## 已知边界

- 列表接口各有上限（记忆 200、洞察 100、决策 100、画像 200），超出时响应里的
  `capped` 为 `true`，界面必须显示截断说明。
- `MODULE_DISABLED` 的 `message` 是给用户看的中文句子，不是给程序判断的枚举；
  程序只应看 `error.code`。
- 向量相关状态（`NO_EMBEDDING_MODEL`、`EMBEDDING_FAILED`）只影响召回质量，
  不影响聊天与记忆的读写；没有可用端点时自动降级为关键词检索。