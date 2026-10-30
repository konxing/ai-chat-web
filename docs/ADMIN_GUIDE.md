# 超级管理员手册

## 初始化（仅一次）

超级管理员不能通过网页注册。必须在服务器控制台执行，密码从 stdin 读取，源码中没有默认密码：

```bash
# 本地 / systemd
npm run bootstrap -- --username owner --email owner@example.com --password-stdin \
  --allow-ip 203.0.113.10 --allow-ip 2001:db8::/64 --site-name "我家的 AI"

# Docker（数据库已启动，app 镜像已构建）
docker compose run --rm -T app npx tsx scripts/bootstrap.ts \
  --username owner --email owner@example.com --password-stdin \
  --allow-ip 203.0.113.10 --site-name "我家的 AI"
```

- 自动加入 `127.0.0.1/32`、`::1/128`（本机 Nginx / 健康检查），除非 `--no-loopback`。
- `--skip-ip` 会让站点默认拒绝所有人；之后必须在服务器上用应急脚本加回 IP。
- 密码需 ≥10 字符、两类字符、不含用户名/邮箱前缀、不是常见口令。
- 已有 OWNER 时不会创建第二个；忘记密码用下方“恢复”。

### 重置 OWNER 密码

```bash
printf '%s\n' "$NEW_PASSWORD" | npm run bootstrap -- --reset-password --username owner --password-stdin
# 或完全离线：
printf '%s\n' "$NEW_PASSWORD" | npx tsx scripts/emergency.ts --reset-owner-password --username owner
```

两者都会撤销该 OWNER 的全部会话并写审计。

## 登录后的管理后台

`/admin` 仅 OWNER 可见。所有写操作会弹出“再次输入当前密码”的确认框；前端与后端都会校验，后端校验失败返回 403。

### 安全概览
用户/启用/停用、24h 登录、24h 拒绝访问、会话/消息/附件、存储、模型、服务状态（uptime、内存、磁盘、数据库延迟/大小/版本）。用于日常巡检。

### 用户管理
- 搜索、分页；创建成员（生成一次性临时密码，仅显示一次，线下告知）。
- 重置密码（撤销该用户全部会话）、停用/启用（停用立即拒绝其会话）、修改邮箱（标记已验证）、永久删除（级联删除聊天/消息/附件/个人模型，需二次确认）。
- OWNER 自身不能被停用/删除；不能通过接口创建第二个 OWNER。

### IP 白名单
- 添加 IPv4/IPv6/CIDR，标签，可选到期时间（临时访问）。
- 启用/停用、删除；列表显示 active/expired/disabled、最后命中时间、创建者。
- **锁死保护**：如果操作会让当前管理员 IP 失去最后一条覆盖规则，返回 `409 LOCKOUT_RISK`，需先添加替代规则。
- 变更立即写审计；Node 网关缓存默认 1 秒；Compose 的 Nginx `auth_request` 无需 reload。
- 静态 include 方案可配置 `NGINX_ALLOWLIST_PATH` + `NGINX_RELOAD_CMD`，应用会在变更后自动重写并可选 reload。

### 登录记录 / 审计日志 / 访问日志
- 登录记录：成功/失败、标识、IP、UA、原因、时间。
- 审计：动作、操作者、目标、前后值（脱敏）、结果、错误、IP、时间。
- 访问日志：被放行/拒绝的 IP、路径、方法、原因、UA、时间；用于识别扫描与配置错误。
- 普通用户没有任何读取这些日志的 API；日志不含密码/Cookie/完整 Key/聊天正文。

### 全局模型
- 新增/编辑/删除全局 Provider：名称、Base URL（生产必须 HTTPS）、API Key、模型 ID、能力（文本/视觉/文件/音频）、参数 JSON、启用、默认。
- “测试连接”会调用 `GET {baseUrl}/models`，只显示状态/模型数量，不返回 Key。
- API Key 使用 AES-256-GCM 加密；列表只显示掩码；浏览器永远拿不到明文。
- 用户可在设置页添加自己的 Provider；只能看到全局启用模型 + 自己的模型。
- 兼容 OpenAI Chat Completions 与 `/audio/transcriptions`；其他厂商需要适配器（当前未内置）。

### 系统配置
站点名称、注册开关（默认关闭）、默认全局模型、最大上传 MB、维护提示。所有修改需要二次密码并写审计。

### 存储与备份
- 查看附件数量/体积、按用户统计、清理无引用孤儿文件（需要二次密码）。
- 创建加密备份、下载（浏览器下载带 SHA-256 校验值）。
- 恢复必须在服务器控制台执行 CLI（避免运行中的 Web 进程覆盖自身数据库），界面会给出具体命令；生产建议在维护窗口执行。详见 [BACKUP_RESTORE.md](BACKUP_RESTORE.md)。

### 服务状态
Node 版本、运行时长、负载、内存、磁盘、数据库连通性与延迟/大小/版本、当前 APP_URL/NODE_ENV。只读。

## 邀请家庭成员

1. 系统配置 → 打开“允许注册”。
2. 把站点地址与注册说明线下发给家人；他们用邮箱验证码注册（SMTP 必须已配置，否则验证码只出现在服务器日志）。
3. 注册完成后建议关闭注册开关，或由管理员直接创建账号。
4. 新用户首次登录后可设置自己的显示名、密码、个人 AI 模型。

## 日常安全检查

- 概览的“24h 拒绝访问”是否异常升高；访问日志是否有扫描路径。
- IP 白名单是否有过期/不再需要的规则；临时规则是否已到期。
- 审计中是否有非预期的管理员操作、模型 Key 变更、恢复操作。
- 备份任务是否成功、备份文件是否可下载并校验 SHA-256。
- `docker compose ps` / `systemctl status family-ai-chat`、磁盘空间、数据库大小。
- 模型 Key 是否临近轮换周期；主密钥轮换见 [ENCRYPTION.md](ENCRYPTION.md)。

## 紧急恢复

无法访问站点时，按顺序：

```bash
# 1) 从服务器控制台临时放行当前公网 IP
npx tsx scripts/emergency.ts --allow-ip 203.0.113.10 --label "recovery"
npm run sync:nginx -- --reload        # 仅使用静态 include 时需要
# Compose 使用 auth_request，无需 reload；等待约 1 秒缓存即可

# 2) 如果 Nginx 也被锁住，先在本机 curl 127.0.0.1:3000 验证应用
curl -sS http://127.0.0.1:3000/api/health

# 3) 如果防火墙锁死，使用云控制台/带外控制台删除 nftables 表
sudo nft delete table inet family_ai_chat

# 4) 忘记 OWNER 密码
printf '%s\n' "$NEW_PASSWORD" | npx tsx scripts/emergency.ts --reset-owner-password --username owner
```

任何应急操作都会写审计（`ip.emergency_allow`、`owner.password_reset_emergency`）。

## 不应做的事

- 不要把 `.env`、主密钥、备份口令、Provider Key 发到聊天/工单/截图。
- 不要直接改数据库里的 `role` 制造第二个 OWNER；接口与 CLI 都假设唯一 OWNER。
- 不要在没有控制台/带外访问的情况下 `nftables --apply` 或修改云安全组。
- 不要用 `prisma db push` 替代生产迁移。
- 不要在未备份时执行恢复或批量删除用户。
