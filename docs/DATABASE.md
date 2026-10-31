# 数据库与数据隔离

PostgreSQL + Prisma。迁移位于 `prisma/migrations/`，生产使用 `prisma migrate deploy`（容器入口自动执行），开发用 `prisma migrate dev`。数据库不保存任何明文 API Key、聊天正文、聊天标题、附件名或附件内容。

## 表与字段

### User
`id`(uuid)、`username`(唯一, ≤32)、`email`(唯一, ≤254)、`emailVerified`、`passwordHash`(Argon2id)、`role`(OWNER/USER)、`status`(ACTIVE/DISABLED)、`displayName`、`createdAt`、`updatedAt`、`lastLoginAt`。索引：`role`、`status`。
约束：唯一超级管理员由 CLI 与业务层共同保证（`ownerCount` 检查；管理员接口不能创建 OWNER）。

### Session
`tokenHash`(唯一, SHA-256)、`csrfHash`(SHA-256)、`userId`、`ip`、`userAgent`、`createdAt`、`lastSeenAt`、`expiresAt`、`revokedAt`。用户删除级联；过期/撤销立即失效；禁用用户时服务端拒绝其全部会话。

### Chat
`userId`、`titleCiphertext`、`modelProviderId`、`modelId`、时间戳。`userId+updatedAt` 索引。删除用户级联；删除模型时 `providerId` 置空，历史聊天仍可读。
**隔离**：所有查询都带 `userId`（`getChatDetail`、`listChats`），不存在“按 id 直取后由前端判断”的路径。

### Message
`chatId`、`role`(SYSTEM/USER/ASSISTANT)、`contentCiphertext`、`modelId`、`providerId`、`status`(COMPLETE/PARTIAL/ERROR)、`errorCode`、token 统计、时间戳。`chatId+createdAt` 索引。删除聊天级联。
**隔离**：先验证聊天属于当前用户，再按 `chatId` 读取/写入；跨用户返回 404（不泄露存在性）。

### Attachment
`userId`、`chatId`、`messageId`、`kind`(IMAGE/FILE/AUDIO)、`originalNameCiphertext`、`mime`、`size`、`sha256`、`storageKey`(唯一)、`extractedTextCiphertext`、`chunksCiphertext`、`createdAt`。
**隔离**：下载接口同时校验 `attachment.userId === session.userId`；文件名与内容均加密。磁盘文件名为随机 key，不使用原始文件名。

### AiProvider
`ownerType`(GLOBAL/USER)、`userId`、`name`、`baseUrl`、`apiKeyCiphertext`、`modelId`、`capabilities`(JSON: text/vision/files/audio)、`params`(JSON)、`enabled`、`isDefault`。
全局模型仅 OWNER 可管理；个人模型仅本人可管理；用户只能看到全局启用模型 + 自己的模型。API Key 永不返回浏览器，列表只返回掩码。

### IpRule
`cidr`(唯一, 规范化)、`label`、`enabled`、`expiresAt`、`createdById`、`lastMatchedAt`。
**默认拒绝**：没有匹配规则即 403。`expiresAt` 到期的规则不参与匹配。管理接口阻止禁用/删除“最后一条覆盖当前管理员 IP 的规则”（409 `LOCKOUT_RISK`），防止把自己锁在门外。

### IpAccessLog
`ip`、`path`、`method`、`allowed`、`reason`、`userAgent`、`createdAt`。只记录 IP/路径/UA/结果，不记录 Cookie、密码、正文或完整密钥。同一 IP+路径 5 秒节流；成功访问 5 分钟节流。

### LoginLog
`userId?`、`identifier`、`ip`、`userAgent`、`success`、`reason`、`createdAt`。失败原因只记粗粒度（如 `invalid_credentials`），不记录密码。

### AuditLog
`actorId?`、`actorLabel`、`action`、`targetType`、`targetId`、`before`/`after`(JSON)、`ip`、`userAgent`、`status`、`error`、`createdAt`。`before/after` 经 `audit.ts` 脱敏；API Key 只记录“已变更”，不记录明文。普通用户无读取接口。

### SystemConfig
`key`、`value`(JSON)、`updatedAt`、`updatedById`。允许的键只有 `siteName`、`registrationOpen`、`defaultProviderId`、`maxUploadMB`、`maintenanceNotice`，未知键忽略，防止通过配置注入任意行为。

### EmailToken
`email`、`purpose`(REGISTER/RESET/EMAIL_CHANGE)、`codeHash`(HMAC)、`username?`、`userId?`、`expiresAt`、`consumedAt`、`attempts`、`ip`、`createdAt`。
验证码 6 位、10 分钟、单次使用、绑定邮箱与用途；错误尝试计数；请求限速由内存 limiter + Nginx 共同承担。

## ER 图

```mermaid
erDiagram
  User ||--o{ Session : has
  User ||--o{ Chat : owns
  User ||--o{ AiProvider : configures
  User ||--o{ Attachment : owns
  User ||--o{ LoginLog : generates
  User ||--o{ AuditLog : acts
  User ||--o{ IpRule : creates
  Chat ||--o{ Message : contains
  Chat ||--o{ Attachment : has
  Message ||--o{ Attachment : includes
  AiProvider ||--o{ Chat : selected
```

## 隔离与权限规则

- 页面与 API 全部在服务端解析会话（`getSession`），不信任前端传入的 `userId`。
- 每个聊天/附件查询都包含所有权条件；跨用户访问统一返回 404。
- 管理员接口统一 `requireOwner`；普通用户访问返回 403（页面也重定向）。
- 删除用户时数据库级联清理其聊天、消息、附件、会话、模型（配置中的 `onDelete: Cascade`）；审计保留 `actorId=null` + `actorLabel` 供追溯。
- 聊天标题/正文/文件名/提取文本/分块/Provider Key 均为密文列；数据库泄露不等于内容泄露。

## 迁移与初始化

```bash
npm run db:migrate        # prisma migrate deploy
npm run db:migrate:dev    # 开发新迁移
npm run bootstrap -- ...  # 唯一 OWNER + 初始 IP + 默认设置
```

生产启动顺序：数据库健康 → `migrate deploy` → bootstrap（仅一次）→ App → Nginx → 对外。不要用 `db push` 替代生产迁移。

## 备份与保留

- 数据库与上传目录一起备份，格式见 [BACKUP_RESTORE.md](BACKUP_RESTORE.md)。
- 建议保留 7 份日备份 + 1 份月备份；备份文件本身已加密，仍应存放在不同介质/账户。
- 日志表可按需在运维窗口清理（`IpAccessLog`、`LoginLog`），但不要删除 `AuditLog` 中与安全事件相关的记录；家庭规模通常无需自动清理。

## 性能参数（PostgreSQL）

下表是在 2026-11-01 对本机实例（PostgreSQL 17.11，数据目录 `D:\FamilyAIChat\pgdata`）实测得到的当前值。`context` 一栏同样取自 `pg_settings`，决定改完要不要重启。这些都属于运维动作，仓库里的代码和脚本不会自动执行。

| 参数 | 当前 | 建议 | context | 原因 |
| --- | --- | --- | --- | --- |
| `random_page_cost` | 4 | 1.1 | user（不用重启） | 数据盘实测为 NVMe SSD（Crucial CT1000P3PSSD8，D: 与系统同盘）。默认值 4 是为机械盘调的，会让规划器认为「走索引 = 大量随机 IO」从而选顺扫，`(userId, createdAt)`、`(ip, createdAt)`、`(action, createdAt)` 这些复合索引在分页查询里就用不上。 |
| `effective_cache_size` | 4 GB | 与 `shared_buffers` 一起提高 | user（不用重启） | 只影响规划器估算，不占内存；设小了同样会把索引方案判贵。 |
| `work_mem` | 4 MB | 保持 | user（不用重启） | 会话消息按 `createdAt` 排序、附件按用户聚合都在这个预算内；调高对当前查询没有可观察收益。 |
| `shared_buffers` | 128 MB | 物理内存的 1/4 | postmaster（要重启） | 默认值。家用机器内存富余时上调能减少密文列的重复读盘。 |
| `max_connections` | 100 | 保持 | postmaster（要重启） | 要和连接串里的 `connection_limit` 一起看：应用池 + `pg_dump` + 迁移 + 手工 psql 必须共用这 100 个槽位。 |

应用侧对应地把连接串写成 `... ?schema=public&connection_limit=8&pool_timeout=10`（`.env.example` 和 `docker-compose.yml` 已同步）。显式上限的意义不是「更快」，而是把占用钉死：Prisma 的默认池大小是 `物理核数 × 2 + 1`，本机 8 个物理核，单实例默认就能开到 17 条连接，而 `server.js`、`prisma migrate`、备份脚本、手工 psql 共用同一个 `max_connections = 100`。家庭规模的真实并发远小于 8，钉在 8 条不会造成排队，同时给备份和迁移留足余量。

`context = user` 的三个参数可以零停机改掉，按库设置即可，不需要重启也不需要改配置文件：

```bash
# 只影响 family_chat 库，立刻对新连接生效；已在池里的旧连接沿用到下次回收
psql -U family_chat -d family_chat -c "ALTER DATABASE family_chat SET random_page_cost = 1.1;"
psql -U family_chat -d family_chat -c "ALTER DATABASE family_chat SET effective_cache_size = '8GB';"
# 验证：新开会话读到的应当是 1.1
psql -U family_chat -d family_chat -c "SHOW random_page_cost;"
```

想全实例生效就用 `ALTER SYSTEM SET ...` + `SELECT pg_reload_conf();`，同样不用重启。只有 `shared_buffers` / `max_connections` 需要重启：Linux 走 `systemctl restart postgresql`，Windows 改 `D:\FamilyAIChat\pgdata\postgresql.conf` 后重启 PostgreSQL 服务。

一条反直觉的记录，避免后来的人「优化」错方向：密文列是 base64 字符串，TOAST 压缩对它是有效的——实测 `enc:v1:` 载荷用 deflate 能从 100% 压到约 75%（省的是 base64 那 25% 冗余，不是密文本身）。所以不要把这些列改成 `STORAGE EXTERNAL` 关掉压缩，那只会让磁盘和 IO 都多花约三分之一。

## 读写路径上已经做掉的事

- 列表类查询（会话详情、更早消息、附件库）用投影 `ATTACHMENT_PUBLIC_SELECT`，把最大的 `chunksCiphertext` 挡在内存之外；只有真的要给模型做检索增强时才整行取。`extractedTextCiphertext` 目前仍在投影里，只为了 DTO 上那个 `hasText` 标记（上传接口有集成测试断言它）——界面并没有用到这个字段，等确认可以摘掉后，列表查询能再省下一次最贵的列。
- 一条用户消息只产生一次 `Chat` UPDATE（活跃时间 + 本轮模型 + 自动标题合并），`updatedAt` 由 `@updatedAt` 自动带上。
- 管理员首页的目录体积统计按 32 个一批并发 `stat`，不再串行等每个文件一次往返。
- IP 白名单缓存把规则查询移出请求路径：冷启动 await 一次，之后由定时器按 `IP_CACHE_MS` 预热，被扫描时数据库的查询频率恒定而不是随请求线性增长。

日志检索仍然用子串匹配（`contains`），没有改成前缀匹配。原因是这个库的 collation 实测为 `Chinese (Simplified)_China.936`，非 C 排序下 `(ip, createdAt)`、`(action, createdAt)` 的 btree 索引服务不了 `LIKE 'x%'`，要额外建 `varchar_pattern_ops` 索引才有意义。在没有那套索引之前，改前缀只会缩小管理员能搜到的范围，换不来任何速度。
