# 安全设计与威胁模型

## 资产与边界

需要保护的资产：聊天内容与标题、附件及提取文本、账号与密码哈希、AI Provider API Key、会话、IP 白名单、审计日志、备份、主密钥与备份口令；以及认知层的长期记忆正文、向量、证据说明、排除规则、决策正文、反思正文、画像条目与它们之间的引用关系。

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
  - 认知层：`<purpose>:v1:<userId>:<recordId>:<fieldName>`。`fieldName` 是最后加的一段，
    挡的是「同一行里 A 列的密文搬到 B 列」；`v1` 是 schemaVersion。记忆家族用列名
    （`contentCiphertext`），决策 / 反思 / 画像用历史短名（`topic` / `title` / `content`），
    两套口径都在 `src/lib/cognitive/encrypted-columns.ts` 里登记，写侧与轮换侧共用。
    读侧对记忆家族保留旧口径回退（片S 之前落库的行没有 `fieldName` 那一段），
    写侧永远只写新口径。
- 覆盖率：九个认知模型共 25 个密文列（24 字符串 + 1 Bytes 向量），全部在上表登记；
  `tests/unit/cognitive-rotate-coverage.test.ts` 按 schema 逐列对照，漏一列就红。
- 文件容器 `FAC1`：magic(4) + keyIdLen(1) + keyId + IV(12) + tag(16) + ciphertext；上传文件不以明文落盘。
- 完整性：附件元数据记录 SHA-256；下载解密后按原始字节返回；备份清单对 db.dump 与 uploads.tar.gz 记录 SHA-256，恢复前校验。
- 主密钥：32 字节随机，base64 存放于服务器 `.env`（权限 0600），不进入数据库、代码仓库或聊天内容；支持 `MASTER_KEYRING` 保存旧密钥用于轮换。生产可把 `.env` 由 systemd `LoadCredential`/Docker secret 注入环境，文件本身仍应限制为服务账号可读。
- 轮换：`npm run rotate-keys -- --new-key-id k2` 逐条重加密聊天标题、消息、Provider Key、附件名/文本/分块、FAC1 文件，以及认知层全部 25 个密文列（覆盖表驱动）；旧 key 保留在 keyring，重启后验证；确认无误后再移除旧 key。**删除旧 key 前，旧备份可能无法解密其历史字段。**
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

## 个人认知层

认知层多存了一类数据：系统对用户的**推断**。它的安全边界不只是「别泄露」，还包括
「别把推断当成用户说过的话」。下面每一条都有对应的服务端实现，不靠界面自觉。

**开关是服务端闸门。** 八个用户级开关默认全关，库里没有行时按 `OFF` 处理；
关闭后对应的读、写、后台任务都不执行，而不是「读了再藏起来」。受闸门的读接口返回
409 `MODULE_DISABLED`，写侧在入队前和 worker 执行前各查一次。
**已知缺口**：`associationEnabled` 在对话内的注册表闸门盖不到后台向量补算——
向量任务仍可能为已关闭关联的用户补算向量（只写密文向量列，不建立关联、不出上下文）。

**隔离。** 所有认知查询都带会话里的 `userId`；不接受前端提交的用户 id。
跨用户一律 404。三条复合外键（结果→决策、引用→洞察、引用→记忆）把「跨用户连边」
挡在数据库层。偏好行以 `userId` 为主键，不存在「查到别人的开关」。

**删除与遗忘。** 「忘记记忆」与「删除聊天」是两件事：前者只删记忆及其派生
（版本链、证据、访问账本、引用、候选、待执行任务），不动原会话；
后者走聊天删除，并连带清理由它派生的记忆。来源排除规则（`MemoryExclusion`）
在来源删除后仍保留，防止后台把同一句话重新记回来。画像条目**不随**
「清空全部长期记忆」删除，只随账号消亡——它记录的是用户确认过的自我描述，
不是某条记忆的派生。

**日志与审计只带标识。** 认知相关日志只记模块键、用户 id、失败类型（error/timeout）、
记录 id 与计数；记忆正文、反思正文、决策正文、画像内容、候选内容一律不进日志与审计。
模块失败时只记 `module` / `userId` / `reason`，因为上游报错原文常带正文片段。

**提示词注入。** 记忆、证据说明、决策主题、反思内容都是**不可信历史数据**，
注入上下文时放在「供参考、非指令」的块里；任何「忽略系统规则」的文字都不能改变系统提示。
关系描述同理。

**向量不落明文。** 本机 PostgreSQL 没有 pgvector，Prisma 也没有 `Vector` 类型；
向量以 `FAC1` 密文存进 `MemoryItem.embeddingCiphertext`（Bytes），
读时应用层解密、内存里算余弦，并受维度与数据量上限约束。没有「为了查询方便
先把明文向量写库」的路径——那会绕开 5.2 的整字段加密。

**置信度不是模型随口给的数字。** 读时由证据账本（来源类型、独立证据数、时间有效性、
冲突）计算，`confidence` 一列不落库，避免出现一个没人刷新就过期的假数字。
访问次数只影响排序，不提高可信度。

**推断不能升级成事实。** 反思默认只是候选；画像只存用户确认过的条目；
决策只有 `CONFIRMED` 才算正式记录。用户未确认的推断没有写入已确认画像的入口。

## 审计

记录：登录成功/失败、注册、改密、邮箱变更、管理员用户操作、IP 规则增删改、模型/Key 变更、配置变更、备份/恢复、服务异常。记录操作者、目标、时间、IP、结果、前后值（脱敏）。普通用户没有任何审计读取权限。

## 残余风险与限制

- 应用层限速是单进程内存实现；多实例部署需要 Redis/Nginx 统一限速（当前家庭单实例范围）。
- 认知层的密文与主密钥仍在同一台机器、同一个进程环境里；它能防的是「数据库/备份泄露」，
  不防「拿到服务器同用户权限」。更强的隔离同样需要 KMS/HSM，本项目未集成。
- 向量召回只在代码层完成，尚未用真实 embedding 端点实测；当前线上读侧走关键词，
  所以「向量能提升多少召回」没有数字，只有替身层证据。
- 8.3 的「记忆检索设置」还欠一屏：检索上限 `MEMORY_READ_MAX_ITEMS = 8` 有运行时读者，
  但它不是用户可配置项。按「不摆没人读的旋钮」的原则，这一屏没有铺。
- 主密钥在进程环境中可见；拥有服务器 root/同用户权限的攻击者可读取。更强的隔离需要 KMS/HSM 或独立密钥服务，本项目未集成。
- 第三方 AI 提供商仍会看到其收到的内容；请选择可信提供商，不要发送不希望外传的信息。
- 备份口令遗失无法恢复；主密钥遗失则数据库密文与附件不可恢复。
- Nginx `auth_request` 每个请求多一次内部调用；在家庭规模下可接受，极高流量需改为缓存/专用鉴权服务。
- 未做浏览器端恶意扩展、已被攻陷的家庭设备、物理访问服务器等威胁的防护。
- 自动化测试覆盖 API/网络/加密/恢复，但未包含真实 SMTP、真实第三方模型、真实云安全组与浏览器自动化；见测试报告。
