# 架构与请求链路

## 总览

```
浏览器
  │  HTTPS / HTTP(301)
  ▼
① 云安全组（可选，最外层）        只放行 80/443，来源=家庭 IP
  ▼
② nftables（可选，主机层）        默认丢弃 80/443，直连 3000 丢弃
  ▼
③ Nginx                           TLS1.2/1.3、HSTS、限速、日志
  │   auth_request /_ip_gate ──►  App /api/health（走 App 的 IP 网关）
  │   非 2xx = 拒绝（fail closed）
  ▼
④ 自定义 Node 网关 server.js      IP 白名单（PostgreSQL，默认拒绝）
  │   校验可信代理、剥离伪造头、写访问日志、注入 nonce
  ▼
⑤ Next.js App Router              CSP、页面、API
  │   requireUser → 会话 + CSRF + Origin
  │   requireOwner → 角色
  │   requireOwnerPassword → 敏感操作二次验证
  ▼
⑥ PostgreSQL + 本地磁盘           加密字段 / FAC1 加密文件
```

四层网络防护都可以独立生效。即使 Nginx 配置被绕过，`server.js` 仍会拒绝未授权 IP；即使有人直接访问 3000，nftables/绑定地址/白名单仍拦。App 层永远默认拒绝。

## 关键请求流程

### 首次访问

1. `server.js` 在 Next 之前运行 `guard(req,res)`。它从 TCP 连接取 peer IP；只有当 peer 属于 `TRUSTED_PROXY_CIDRS` 时才读取 `X-Real-IP`，随后删除 `Forwarded`、`X-Forwarded-For`、`X-Real-IP`，写入可信的 `x-real-ip` / `x-client-ip` 和随机 CSP nonce。
2. 白名单规则从数据库加载，由后台定时器按 `IP_CACHE_MS`（默认 1000ms）刷新，请求路径不等待 SQL（仅冷启动首次加载会等）；数据库故障超过 5 秒时返回 503（fail closed，而不是放行）。
3. 未命中规则：403 品牌页，并写 `IpAccessLog`（同一 IP 5 秒节流），不含密码/密钥。
4. 命中：进入 Next。根页面展示 3.9 秒入场动画（可跳过；`prefers-reduced-motion` 时 0.7 秒；同会话 0.9 秒），随后去 `/login`。
5. 登录成功后写入 `fac_session`（HttpOnly、SameSite=Lax、生产 Secure）与 `fac_csrf`（非 HttpOnly，供前端读取）。数据库只保存两者的 SHA-256。

### 聊天 / SSE

1. `POST /api/chats/[id]/messages`：会话 + CSRF + 同源校验，校验聊天归属（`userId`），读取加密历史，解密后构建上下文。
2. 服务器从管理员/用户配置的 provider 解密 API Key（仅服务器内存），进行 SSRF 校验与 DNS 固定，向 OpenAI 兼容接口发起流式请求。
3. 响应以 `text/event-stream` 透传给浏览器；Nginx `proxy_buffering off` 保证逐字到达。
4. 用户消息与助手消息以 AES-256-GCM 密文落库；中断时保存 `PARTIAL`/`ERROR` 状态。
5. 浏览器端用 `react-markdown` + `remark-gfm` + `remark-math/rehype-katex` 渲染；代码块可复制。

### 上传 / 语音

1. `POST /api/upload`（multipart）限制大小与字段；根据魔数识别类型，仅允许图片、PDF、DOCX、TXT/MD/CSV、常见音频。
2. 文件名清洗（防路径穿越/XSS），SHA-256 记录；文本类解析（PDF/DOCX/TXT）后按 3000 字符、200 重叠分块，分块与提取文本加密。
3. 文件内容用 `FAC1` 容器加密写盘，数据库只存随机 `storageKey`。下载时校验附件归属，解密后以安全头返回。
4. 语音优先浏览器原生语音识别；若不支持且配置了音频模型，则 `MediaRecorder` 录音并调用 `/api/stt` 转写。

### 管理后台

- `/admin` 页面一次性拉取概览、用户、IP、日志、模型、存储、服务状态；所有变更请求必须带 CSRF。
- 所有管理员写操作（用户、IP、模型、配置、备份、恢复）都调用 `requireOwnerPassword`，要求当前管理员密码；前端有 Reauth 对话框。
- 审计写入 `AuditLog`，敏感字段经过 `audit.ts` 脱敏；普通用户没有任何读取审计的 API。
- IP 规则变更后 `edge-sync.ts` 异步重写可选的 Nginx allowlist 文件并可执行 reload，用于静态 include 方案；Compose 使用 `auth_request`，无需 reload 即生效。

## 模块边界

| 模块 | 职责 |
| --- | --- |
| `server.js` | 网络层 IP 网关、可信代理、TLS、安全头、访问日志、优雅退出 |
| `src/middleware.ts` | CSP nonce、安全响应头、未登录页面快速重定向 |
| `src/lib/auth.ts` | `requireUser` / `requireOwner` / 二次密码校验 |
| `src/lib/session.ts` | 不透明会话 token、CSRF、过期/撤销 |
| `src/lib/password.ts` | Argon2id 哈希与密码策略 |
| `src/lib/crypto.ts` | AES-256-GCM、keyring、FAC1、SHA-256/HMAC |
| `src/lib/ip.ts` | IPv4/IPv6/CIDR 规范化与匹配 |
| `src/lib/ssrf.ts` | URL 校验、DNS pinning、重定向阻断 |
| `src/lib/ai.ts` / `providers.ts` | OpenAI 兼容流式调用、能力与参数 |
| `src/lib/files.ts` | 魔数、解析、分块、加密存储 |
| `src/lib/backups.ts` | 备份列表、下载完整性、恢复调用 |
| `src/lib/admin.ts` | 管理后台业务与审计 |

## 技术栈

- Next.js 15.5 App Router、React 19、TypeScript 5.8（strict）、Tailwind CSS 3.4
- Node.js 22 自定义服务器（在 Next 之前拦截全部路径）
- PostgreSQL 14+、Prisma 6（迁移、事务、级联删除）
- Nginx（TLS、`auth_request`、限速、SSE 关闭缓冲）
- Docker Compose 或 systemd 裸机部署
- Vitest 单元测试 + Bash/curl 隔离式 E2E

## 设计取舍

- **不透明会话而非 JWT**：可即时撤销、数据库只存哈希、无签名密钥轮换负担。
- **整字段加密而非透明列加密**：密钥不进入数据库，备份即使泄露也需独立主密钥；代价是无法对标题/正文做数据库全文检索（当前不需要）。
- **Nginx auth_request 而不是静态 allow 文件**：IP 变化立即生效，不需要 reload；代价是每个请求多一次内部健康检查（应用层本来也要检查，缓存后开销很小）。
- **默认拒绝 + 无默认密码**：部署多一步 bootstrap，但避免“默认口令被扫到”的常见事故。
