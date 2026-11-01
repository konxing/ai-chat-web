# 安全设计与威胁模型

## 资产与边界

需要保护的资产：聊天内容与标题、附件及提取文本、账号与密码哈希、AI Provider API Key、会话、IP 白名单、审计日志、备份、主密钥与备份口令。

信任边界：

- 公网完全不可信；未列入白名单的 IP 在 Nginx 与 Node 两层都被拒绝。
- 只有 `TRUSTED_PROXY_CIDRS` 中的 TCP peer 才能断言 `X-Real-IP`。从其他来源发来的 `X-Forwarded-For` / `X-Real-IP` 一律删除。
- 浏览器不可信；所有权限判断在服务端，前端只负责展示。
- 第三方 AI 服务会收到发给它的聊天内容；这在设置页与文档中明确告知。API Key 仅服务器可见。
- 数据库文件、上传目录、备份文件可能泄露；因此正文/标题/文件名/Key/文件内容均加密。

## 认证与会话

- 密码：Argon2id（m=19456 KiB, t=2, p=1），每密码独立盐；策略要求 ≥10 字符、至少两类字符、不得包含用户名/邮箱前缀、拒绝常见弱口令；登录对不存在用户执行 dummy verify，降低时间侧信道。
- 会话：32 字节随机不透明 token，数据库只存 SHA-256；`HttpOnly`、`SameSite=Lax`、生产 `Secure`、30 天；`lastSeenAt` 5 分钟节流更新。
- CSRF：`fac_csrf` 非 HttpOnly + `x-csrf-token`，数据库存 SHA-256，`timingSafeEqual` 比较；所有变更请求校验，另校验 `Origin`（存在时）。
- 撤销：退出、改密、重置密码、禁用用户、管理员强制下线都会立即撤销会话。
- 登录限速：IP 20 次/15 分钟；同一 identifier 8 次/15 分钟；注册/找回另有 IP 与邮箱维度；Nginx 对凭证端点再限速 20r/m。
- 超级管理员只能由 CLI 创建；接口不能创建第二个 OWNER；OWNER 不能删除/禁用自己；管理员敏感写操作要求再次输入当前密码。

## 加密

- 对称加密：AES-256-GCM，96-bit 随机 IV，128-bit tag；密文格式 `enc:v1:<keyId>:<iv>:<tag>:<ciphertext>`（base64url）。
- AAD 绑定上下文，防止把密文从一条记录搬到另一条记录：
  - `chat-title:<chatId>`
  - `message:<messageId>`
  - `provider-key:<providerId>`
  - `attachment-name|text|chunks:<attachmentId>`
  - `file:<attachmentId>`
- 文件容器 `FAC1`：magic(4) + keyIdLen(1) + keyId + IV(12) + tag(16) + ciphertext；上传文件不以明文落盘。
- 完整性：附件元数据记录 SHA-256；下载解密后按原始字节返回；备份清单对 db.dump 与 uploads.tar.gz 记录 SHA-256，恢复前校验。
- 主密钥：32 字节随机，base64 存放于服务器 `.env`（权限 0600），不进入数据库、代码仓库或聊天内容；支持 `MASTER_KEYRING` 保存旧密钥用于轮换。生产可把 `.env` 由 systemd `LoadCredential`/Docker secret 注入环境，文件本身仍应限制为服务账号可读。
- 轮换：`npm run rotate-keys -- --new-key-id k2` 逐条重加密聊天标题、消息、Provider Key、附件名/文本/分块与 FAC1 文件；旧 key 保留在 keyring，重启后验证；确认无误后再移除旧 key。**删除旧 key 前，旧备份可能无法解密其历史字段。**
- 备份：独立 `BACKUP_PASSPHRASE`，scrypt(N=2^15, r=8, p=1) 派生密钥，AES-256-GCM，magic `FACBACKUP1`；备份内容包含数据库 dump 与上传归档。备份口令与主密钥应分开保管。

## Web 安全

- SQL 注入：全部通过 Prisma 参数化查询/ORM，无字符串拼接 SQL。
- XSS：React 默认转义；Markdown 渲染未启用原始 HTML；CSP 使用 per-request nonce + `strict-dynamic`，生产禁用 `unsafe-eval`；上传文件名清洗；下载响应 `nosniff`、`Content-Security-Policy: default-src 'none'; sandbox`、附件默认 `Content-Disposition: attachment`（仅图片/音频允许显式 inline）。
- CSRF：见上；SameSite=Lax 作为第二层。
- 点击劫持：`X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`。
- 开放重定向：登录后固定去 `/chat`，无用户可控跳转参数。
- SSRF：Provider URL 仅 http/https（生产强制 https）；拒绝 userinfo、fragment、超长 URL；解析所有 DNS 记录并拒绝私有/环回/保留地址；用 undici 自定义 `lookup` 固定已校验 IP，防 DNS rebinding；`redirect: 'manual'` 拒绝 3xx；超时中止。`ALLOW_PRIVATE_AI_URLS=true` 仅用于本地测试。
- 上传：大小限制、multipart 字段限制、魔数识别、扩展名仅作 DOCX 辅助判断、随机存储 key、路径必须位于 upload 根目录、跨用户 404、已用于消息的附件不可单独删除。
- 会话劫持：HttpOnly + Secure + SameSite、服务端撤销、IP/UA 仅记录不参与授权（避免 NAT 误伤）、无 token 于 URL。
- 暴力破解：应用层内存限速 + Nginx 限速；验证码 6 位、10 分钟、最多 5 次错误、单次使用、绑定邮箱/用途、HMAC 存储。
- 信息泄露：API 错误不返回堆栈；生产日志不记录密码、Cookie、完整 API Key、聊天正文；审计 before/after 脱敏；`/api/health` 仅返回状态。

## 网络与运维

- `server.js` 默认拒绝；数据库不可用超过 5 秒返回 503，而不是 fail-open；白名单缓存默认 1 秒，规则改动由后台定时器预热，最迟约 2×`IP_CACHE_MS` 生效。
- 403 页面不回显任意 header，只回显清洗后的 IP。
- Nginx `auth_request` 失败即拒绝；TLS 仅 1.2/1.3，HSTS 2 年；HTTP 301 到 HTTPS；SSE 关闭缓冲；访问日志去掉 query string。
- nftables 只处理 80/443 与 3000，不影响 SSH；云安全组作为最外层。任何防火墙变更前先保留控制台/带外访问。
- 备份文件、`.env`、证书私钥、`deploy/nginx/ssl/` 均在 `.gitignore`/`.dockerignore` 中；镜像构建使用无意义占位环境变量，不烘焙真实密钥。
- Windows 单机部署的数据目录（`pgdata`/`uploads`/`backups`）不继承 `BUILTIN\Users` 与 `Authenticated Users`，只留给属主、SYSTEM、Administrators，数据库服务账号按最小需要单独授予；基线与回滚见 [DEPLOYMENT.md](DEPLOYMENT.md) 第 13 节。

## 审计

记录：登录成功/失败、注册、改密、邮箱变更、管理员用户操作、IP 规则增删改、模型/Key 变更、配置变更、备份/恢复、服务异常。记录操作者、目标、时间、IP、结果、前后值（脱敏）。普通用户没有任何审计读取权限。

## 残余风险与限制

- 应用层限速是单进程内存实现；多实例部署需要 Redis/Nginx 统一限速（当前家庭单实例范围）。
- 主密钥在进程环境中可见；拥有服务器 root/同用户权限的攻击者可读取。更强的隔离需要 KMS/HSM 或独立密钥服务，本项目未集成。
- 第三方 AI 提供商仍会看到其收到的内容；请选择可信提供商，不要发送不希望外传的信息。
- 备份口令遗失无法恢复；主密钥遗失则数据库密文与附件不可恢复。
- Nginx `auth_request` 每个请求多一次内部调用；在家庭规模下可接受，极高流量需改为缓存/专用鉴权服务。
- 未做浏览器端恶意扩展、已被攻陷的家庭设备、物理访问服务器等威胁的防护。
- 自动化测试覆盖 API/网络/加密/恢复，但未包含真实 SMTP、真实第三方模型、真实云安全组与浏览器自动化；见测试报告。
