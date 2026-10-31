# 部署与运维

以下步骤假设 Ubuntu 22.04/24.04 + Docker Compose v2，服务器有公网 IPv4（可选 IPv6）。**不要购买任何云资源或修改生产环境，除非你已获得授权并确认了回滚方案。** 本项目不包含云账号操作。

## 1. 准备

```bash
sudo apt update && sudo apt install -y ca-certificates curl git openssl
sudo install -m 0755 -d /srv/family-ai-chat
# 将代码放到 /srv/family-ai-chat（git clone 或上传发布包）
cd /srv/family-ai-chat

# 非 root 服务账号（裸机部署用；Docker 可跳过）
sudo useradd --system --home /srv/family-ai-chat --shell /usr/sbin/nologin familyai
```

端口：公网只开 80/443；应用 3000 不对外。数据库 5432 不对外。SSH 仅管理 IP。

## 2. 生成密钥与配置

```bash
cp .env.docker.example .env
chmod 600 .env

openssl rand -base64 32   # APP_SECRET
openssl rand -base64 32   # MASTER_KEY
openssl rand -base64 24   # BACKUP_PASSPHRASE
openssl rand -hex 24      # POSTGRES_PASSWORD（仅 URL 安全字符）
```

填写 `.env`：

- `APP_URL=https://chat.example.com`（生产必须 https）
- `APP_SECRET`、`MASTER_KEY`、`MASTER_KEY_ID=k1`
- `POSTGRES_PASSWORD`，并与 compose 的数据库密码一致
- `BACKUP_PASSPHRASE`（≥12 字符，和主密钥分开保管）
- `EMAIL_TRANSPORT=smtp` 及 SMTP 参数（首次可用 console 看验证码）
- `ALLOW_PRIVATE_AI_URLS=false`
- `TRUSTED_PROXY_CIDRS` 在 Compose 中由 compose 覆盖为 `172.28.0.10/32`；裸机为 `127.0.0.1/32,::1/128`

**`.env` 不要提交、不要进镜像、不要发聊天。** 生产建议将主密钥/备份口令放入 systemd credential 或 Docker secret，再注入环境变量。

## 3. TLS 证书

### 生产（Let's Encrypt，HTTP-01 webroot）

```bash
sudo apt install -y certbot
sudo certbot certonly --webroot \
  -w /srv/family-ai-chat/deploy/certbot/www \
  -d chat.example.com --email you@example.com --agree-tos --no-eff-email

sudo install -m 600 /etc/letsencrypt/live/chat.example.com/privkey.pem \
  /srv/family-ai-chat/deploy/nginx/ssl/privkey.pem
sudo install -m 644 /etc/letsencrypt/live/chat.example.com/fullchain.pem \
  /srv/family-ai-chat/deploy/nginx/ssl/fullchain.pem
```

续期后需要重新复制并 reload：

```bash
sudo certbot renew --deploy-hook 'install -m 600 /etc/letsencrypt/live/chat.example.com/privkey.pem /srv/family-ai-chat/deploy/nginx/ssl/privkey.pem && install -m 644 /etc/letsencrypt/live/chat.example.com/fullchain.pem /srv/family-ai-chat/deploy/nginx/ssl/fullchain.pem && docker compose -f /srv/family-ai-chat/docker-compose.yml exec nginx nginx -s reload'
```

> 如果域名未解析到本机，HTTP-01 无法通过。可先用自签证书验证部署，再切换真实证书。

### 本地/测试

```bash
CN=localhost bash deploy/scripts/generate-self-signed-cert.sh
# 浏览器会警告自签证书，这是预期；不要用于生产。
```

## 4. 构建并初始化（在公网开放之前）

```bash
docker compose build
docker compose up -d db
docker compose run --rm -T app npx tsx scripts/bootstrap.ts \
  --username owner --email owner@example.com --password-stdin \
  --allow-ip 203.0.113.10 --allow-ip 2001:db8::/64 \
  --site-name "我家的 AI" <<< '替换成强密码'
```

- 容器入口会先执行 `prisma migrate deploy`；bootstrap 会创建唯一 OWNER、默认配置和初始 IP 规则。
- 默认加入 `127.0.0.1/32`、`::1/128`，用于 Nginx `auth_request` 与健康检查。**Compose 部署不要加 `--no-loopback`，否则 Nginx 健康检查失败、站点无法启动。**
- 首次启动前确认 `--allow-ip` 包含你当前公网 IP；IPv6 用户要同时加 IPv6 规则。
- 密码从 stdin 读取，不出现在命令历史/进程参数中。

## 5. 启动与验证

```bash
docker compose up -d
docker compose ps                 # db/app/nginx 均为 healthy/running
docker compose logs -f app        # 观察迁移、监听、错误
```

验证：

```bash
# 允许 IP
curl -I https://chat.example.com/login
curl -s https://chat.example.com/api/health

# 未允许 IP（从另一网络/手机热点）应得到 403，且看不到登录页
# 伪造 XFF 不应绕过
curl -k https://chat.example.com/api/health -H 'X-Real-IP: 127.0.0.1'

# 证书与 HSTS
openssl s_client -connect chat.example.com:443 -servername chat.example.com </dev/null 2>/dev/null | grep -E 'Protocol|Cipher'
curl -sI https://chat.example.com/login | grep -i strict-transport
```

登录后创建全局模型、测试连接、发一条消息、上传一个小文件，确认流式与附件正常。

## 6. 云安全组（最外层）

在云控制台（不是本仓库）配置：

- 入站 80/443：仅家庭公网 IP/CIDR；IPv6 也配置。
- 入站 22：仅管理 IP；最好通过 VPN/堡垒机。
- 其他入站：拒绝。
- 出站：至少 DNS、SMTP、AI Provider；不需要全开。
- 不要放行 3000/5432。

先在云控制台确认当前 IP，再改规则；保留云厂商 Web 控制台/串口控制台作为带外恢复通道。**本项目不会替你修改云资源。**

## 7. nftables（可选，主机层）

```bash
# 生成 + 语法检查（不会应用）
npm run sync:firewall

# 确认当前 IP 在集合内、且你有控制台后：
sudo nft -f deploy/nftables/family-ai-chat.generated.nft
# 或
npm run sync:firewall -- --apply
```

规则只处理 80/443 与 3000，不影响 SSH；云安全组仍是外层。Docker 部署时，nftables 在宿主机过滤 Nginx 的 80/443，需要和数据库白名单保持一致；如果只使用 Docker 的 `auth_request`，可先不启用 nftables 的 80/443 集合规则。

恢复：`sudo nft delete table inet family_ai_chat`。

## 8. 裸机部署（systemd + 主机 Nginx）

```bash
sudo mkdir -p /srv/family-ai-chat
# 复制代码到 /srv/family-ai-chat，chown -R familyai:familyai
cd /srv/family-ai-chat
sudo -u familyai npm ci
sudo -u familyai npm run build
sudo -u familyai npx prisma migrate deploy
sudo -u familyai npm run bootstrap -- --username owner --email ... --password-stdin
```

- `cp .env.example .env` 后填写；`chmod 600 .env`。
- 安装 `deploy/systemd/family-ai-chat.service` 到 `/etc/systemd/system/`，按实际路径/用户修改。
- `sudo systemctl daemon-reload && sudo systemctl enable --now family-ai-chat`
- 安装 `deploy/nginx/family-ai-chat.host.conf` 到 `/etc/nginx/conf.d/`，`deploy/nginx/proxy-common.conf` 到 `/etc/nginx/`，替换域名/证书路径。
- `sudo nginx -t && sudo systemctl reload nginx`
- 安装备份 timer：
  ```bash
  sudo install -m 644 deploy/systemd/family-ai-chat-backup.service /etc/systemd/system/
  sudo install -m 644 deploy/systemd/family-ai-chat-backup.timer /etc/systemd/system/
  sudo systemctl daemon-reload && sudo systemctl enable --now family-ai-chat-backup.timer
  ```
- 日志轮转：`sudo install -m 644 deploy/logrotate/family-ai-chat /etc/logrotate.d/family-ai-chat`

> `ReadWritePaths` 必须包含 `/srv/family-ai-chat/.next/cache`，否则 Next 图片优化/缓存写入会失败。

## 9. 日常启停

```bash
# Compose
docker compose up -d
docker compose restart app
docker compose stop
docker compose down                 # 保留卷
# 绝对不要 docker compose down -v：会删除数据库/上传/备份卷

# systemd
sudo systemctl restart family-ai-chat
sudo systemctl status family-ai-chat --no-pager
journalctl -u family-ai-chat -f
```

更新流程：备份 → `git pull`/替换代码 → `docker compose build` → `docker compose up -d` → 验证；数据库迁移由入口自动执行。回滚前先看迁移是否可逆（Prisma 迁移默认不自动回滚）。

## 10. 日志与监控

- 应用：stdout JSON（`ts`、`level`、`event`），Docker logs 或 journald；`LOG_LEVEL=info`，排障时可短时 `debug`。
- Nginx：`/var/log/nginx/family-ai-chat.access.log`（不含 query，含 `rt`/`urt`）、`error.log`；logrotate 见 `deploy/logrotate/`。
- 业务审计：管理后台“登录记录/审计日志/访问日志”。
- 健康检查：`GET /api/health`（受白名单限制，从本机或允许 IP 访问）。Docker 内置 app/nginx healthcheck。
- 建议监控：磁盘剩余（上传/备份/数据库）、备份文件年龄、`/api/health` 状态、5xx 率、数据库连接数、证书到期。
- 外部 uptime 监控若不在白名单，只能监控 TCP 端口或先加入白名单；不要为了监控把 3000/API 公开。

## 11. 常见故障

| 现象 | 排查 |
| --- | --- |
| 所有 IP 403 | 数据库无启用规则；`TRUSTED_PROXY_CIDRS` 未包含 Nginx 地址；规则 CIDR 不覆盖当前 IP；等待 `IP_CACHE_MS` |
| 502/500，健康检查失败 | app 未启动/迁移失败；`docker compose logs app`；`curl 127.0.0.1:3000/api/health`；数据库连接 |
| Nginx 启动失败 | 证书路径/权限；`docker compose logs nginx`；`docker compose exec nginx nginx -t` |
| 登录后立刻退出 | `APP_URL` 与访问域名不一致导致 Secure Cookie/Origin；多入口访问要给 `ALLOWED_ORIGINS`；检查 HTTPS 与反向代理头 |
| 收不到验证码 | `EMAIL_TRANSPORT=console` 时看日志；SMTP 配置/端口/垃圾邮件；生产禁止 `file` |
| 模型连接失败 | Base URL 必须 HTTPS 且公网；SSRF 阻断私网；`/models` 是否可用；Key 是否有效 |
| 上传 413 | Nginx `client_max_body_size`(25m)、应用 `MAX_UPLOAD_MB`、反向代理限制 |
| 备份失败 | `pg_dump` 版本与数据库匹配；`BACKUP_DIR` 可写；`BACKUP_PASSPHRASE` 长度；磁盘空间 |
| 磁盘满 | 清理旧备份/日志；检查 uploads；不要直接删数据库文件 |

## 12. 升级/迁移注意

- 升级前：`npm run backup`，下载并校验 SHA-256，确认 `.env`/主密钥已离线保存。
- Prisma 迁移在启动时自动执行；大版本升级前先在 staging 用同版本 PostgreSQL 演练。
- 更换域名会改变 `APP_URL`：Secure Cookie 与 Origin 校验都会受影响，需重新登录；过渡期可把旧域名一并写进 `ALLOWED_ORIGINS`。
- 更换服务器：迁移数据库、uploads、`.env`（主密钥必须一致）、证书；恢复后验证历史聊天/附件可解密。
- 主密钥轮换见 [ENCRYPTION.md](ENCRYPTION.md)；不要在没验证前删旧 key。
