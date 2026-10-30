# 澄境 · Family AI Chat

一个自托管的家庭私人 AI 聊天站点：默认拒绝所有网络访问，只允许服务器所有者明确授权的 IP；超级管理员独占管理权限；聊天、标题、附件与 API Key 在数据库/磁盘中加密；每个家庭成员的数据严格隔离。

这不是演示页。登录、注册、邀请、找回密码、流式对话、图片/文件/语音、管理后台、IP 白名单、审计、备份恢复、密钥轮换与 TLS 均已实现并通过自动化测试。

## 功能

- **网络层默认拒绝**：自定义 `server.js` 在 Next.js 之前检查 IP，连 `_next/static`、健康检查、API 也不例外；Nginx `auth_request` 形成第二道动态边界；可选 nftables / 云安全组。IPv4、IPv6、CIDR、临时规则、到期自动失效。
- **账号体系**：用户名或邮箱登录、邮箱验证码注册、找回/重置密码、持久会话、单设备会话撤销、禁用用户、Argon2id 哈希、登录/审计/访问日志。
- **唯一超级管理员**：只能通过服务器控制台 CLI 创建，源码无默认密码；普通用户无法进入管理后台；管理员敏感操作要求再次输入密码。
- **管理后台**：概览、用户、IP 白名单、登录日志、审计日志、模型/API Key、存储、备份、服务状态、系统配置、注册开关。
- **AI 对话**：全局/个人 OpenAI 兼容模型，按聊天切换模型，SSE 流式输出，Markdown/代码复制/KaTeX 数学公式，图片、PDF、DOCX、TXT/MD/CSV 与语音输入，长文档分块检索，历史保存/重命名/删除。
- **加密**：AES-256-GCM（带 AAD）、SHA-256 完整性、随机 nonce、主密钥 keyring 与在线轮换、加密备份（scrypt + AES-GCM）、上传文件 `FAC1` 加密容器。
- **安全边界**：SameSite/HttpOnly/Secure Cookie、CSRF 双提交、CSP nonce、SSRF 防护（DNS 固定、私网阻断、禁跳转）、上传魔数检测、路径/文件名清洗、限速、审计脱敏。
- **部署**：Dockerfile、Compose（App + PostgreSQL + Nginx）、裸机 systemd/Nginx/nftables 配置、TLS 1.2/1.3 + HSTS、日志轮转、健康检查、备份定时器。

## 快速开始（Docker Compose）

```bash
cp .env.docker.example .env
chmod 600 .env
# 填写：POSTGRES_PASSWORD、APP_URL、APP_SECRET、MASTER_KEY、BACKUP_PASSPHRASE、SMTP...
openssl rand -base64 32   # 用于 APP_SECRET / MASTER_KEY

# 准备 TLS 证书（生产用真实 CA；本地测试可自签）
CN=localhost bash deploy/scripts/generate-self-signed-cert.sh

docker compose build
docker compose up -d db
# 首次启动前先初始化唯一超级管理员（不会自动创建）：
docker compose run --rm -T app npx tsx scripts/bootstrap.ts \
  --username owner --email owner@example.com --password-stdin \
  --allow-ip 203.0.113.10 --site-name "我家的 AI" <<< '替换成强密码'
docker compose up -d
```

然后访问 `https://你的域名`。**在完成 bootstrap 与 IP 白名单之前，不要把服务暴露到公网。** 完整步骤、密钥生成、证书、云安全组与故障排查见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

> `bootstrap` 会默认加入 `127.0.0.1/32` 与 `::1/128`（仅供本机 Nginx/健康检查），并加入你通过 `--allow-ip` 传入的地址。若不加任何规则，站点会拒绝所有人。

## 常用命令

```bash
npm run typecheck           # TypeScript
npm run test:unit           # 74 个单元测试
npm run test:integration    # 147 项端到端检查（隔离数据库）
npm run test:all            # 类型 + 单元 + 构建 + 集成
npm run bootstrap -- --help # 初始化 / 重置 owner
npm run sync:nginx -- --reload
npm run sync:firewall -- --apply   # 先阅读文档，确认控制台可用
npm run rotate-keys -- --new-key-id k2
npm run backup
npm run restore -- backups/xxx.facbackup --yes
```

## 目录

```
src/app/            页面与 API 路由（App Router）
src/components/     聊天、登录、设置、管理后台 UI
src/lib/            鉴权、加密、IP、AI、上传、备份、审计等核心逻辑
prisma/             schema 与迁移
scripts/            bootstrap、轮换、同步、备份、恢复、应急
server.js           在 Next 之前的网络层 IP 网关 + TLS
deploy/             Nginx、nftables、systemd、logrotate、证书脚本
tests/              单元测试与隔离式 E2E 脚本
docs/               架构、数据库、加密、管理、IP、部署、备份、测试、安全
```

## 文档

- [架构与请求链路](docs/ARCHITECTURE.md)
- [数据库与数据隔离](docs/DATABASE.md)
- [加密与密钥轮换](docs/ENCRYPTION.md)
- [超级管理员手册](docs/ADMIN_GUIDE.md)
- [IP 白名单与网络边界](docs/IP_WHITELIST.md)
- [部署与运维](docs/DEPLOYMENT.md)
- [备份、恢复与灾难恢复](docs/BACKUP_RESTORE.md)
- [安全设计与威胁模型](docs/SECURITY.md)
- [测试报告与未完成项](docs/TEST_REPORT.md)

## 明确不做/未验证

- 不包含云厂商资源购买、真实域名证书签发、真实 SMTP/第三方 AI 账号；这些需要你自己的凭据，见测试报告中的“未验证项”。
- 没有多租户、团队协作、支付、插件市场；范围是家庭自用。
- 浏览器自动化（Playwright）未纳入本仓库；UI 通过生产构建与真实 HTTP/会话流程验证。
