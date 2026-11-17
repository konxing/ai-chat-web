# IP 白名单与网络边界

目标：任何未被明确授权的 IP，在到达登录页、动画、API、静态资源或聊天之前就被拒绝。**默认拒绝，失败关闭**。

## Nginx 部署的四层防护

| 层 | 位置 | 作用 | 动态性 |
| --- | --- | --- | --- |
| 1 | 云安全组 / 防火墙 | 只放行可信 IP 到 80/443；SSH 仅管理 IP | 云控制台变更 |
| 2 | nftables | 主机层默认丢弃 80/443，直连 3000 丢弃 | `sync:firewall` 生成，`--apply` 生效 |
| 3 | Nginx | TLS、限速、`auth_request /_ip_gate` 动态询问应用 | ≤ 2×`IP_CACHE_MS` |
| 4 | Node `server.js` | 所有请求（含 `_next/static`、API、健康检查）先过白名单 | ≤ 2×`IP_CACHE_MS`（默认约 2 秒） |

应用层是最终底线；即使 Nginx 配置错误、静态资源被单独暴露，未授权 IP 仍会得到 403。

## 规则模型

- 支持 IPv4、IPv6、CIDR；入库前规范化（IPv4-mapped IPv6 转为 IPv4，CIDR 网络地址掩码化）。
- 多条规则取并集；`enabled=false` 或 `expiresAt <= now` 不参与匹配。
- 临时访问：设置到期时间，到期后自动失效（无需重启/清理任务）。
- 默认拒绝：没有匹配规则即 403；数据库不可用超过 5 秒返回 503（不会放行）。
- 白名单缓存默认 1000ms（`IP_CACHE_MS`，最小 200ms），由后台定时器刷新，请求路径不等待数据库查询；删除/停用规则最迟约 2×`IP_CACHE_MS` 生效。

## 真实客户端 IP 与可信代理

默认使用直连模式。使用普通反向代理时，显式启用代理模式并列出代理实际连接后端的地址：

```env
TRUST_PROXY=true
TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128   # 裸机 Nginx
# Compose: 172.28.0.10/32（Nginx 容器静态地址）
```

直连模式使用 TCP 来源，并拒绝带转发头的请求。普通代理模式只有在 TCP 对端属于可信代理名单、且代理写入了单个有效 `X-Real-IP` 时，才按该地址检查白名单及计算登录限流。缺失或无效的代理地址会拒绝请求。代理报告的回环地址仅可用于只读健康检查和 Nginx 内部探测；这些检查仍需要回环白名单。

- 反向代理必须覆盖来访请求的 `X-Real-IP`，写入它验证过的客户端地址。将应用端口限制在反向代理能够访问的本地或私有网络内。
- Node 在转交页面和 API 前重新写入 `x-real-ip` / `x-client-ip`。空白或不合法的代理配置会使服务拒绝启动。
- CDN 等多级代理需要在入口额外校验回源地址并确定真实客户端 IP。只转发 TCP 流量的隧道无法提供这个凭据。

### Cloudflare Tunnel 同机直连

当 `cloudflared` 和 AI WebChat EXE 部署在同一台 Windows 主机上，可显式启用 Cloudflare Tunnel 模式：

```env
WINDOWS_USE_PROXY=true
WINDOWS_PROXY_PROVIDER=cloudflare
APP_URL=https://stepmark.xin
TRUSTED_PROXY_CIDRS=127.0.0.1/32
```

- 公网流量从 `https://stepmark.xin` 进入，`cloudflared` 的 Published application 路由直接指向 `http://127.0.0.1:3000`。保留域名的 `Host`，或者把 Tunnel 的 **HTTP Host Header** 设成 `stepmark.xin`。保持 3000 端口仅对本机回环开放，确保 `cloudflared` 与后端之间直接通信。[Windows 配置步骤](../scripts/windows/README.md#cloudflare-tunnel-与-exe-同机运行)
- 应用验证 TCP 对端属于配置的本机地址，并且回源请求携带单个有效的 `CF-Connecting-IP`。该地址用于白名单、访问记录及登录限流。应用拒绝缺失、多值或异常的访客 IP、Pseudo IPv4 地址和带 `CF-Worker` 的请求。此模式只从 `CF-Connecting-IP` 取访客地址。[Cloudflare 请求头说明](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip)
- `127.0.0.1/32` 校验的是连接地址，不能识别具体进程。请在由你控制、仅运行可信程序的 Windows 主机上启用此模式。保持回环端口的访问范围位于该主机内，Cloudflare 域名直接路由到该 Tunnel。
- 访客白名单填浏览器访问 Cloudflare 时实际使用的公网 IPv4 或 IPv6。保留 `127.0.0.1/32` 供本机启动器健康检查。保留 Cloudflare 的 `CF-Connecting-IP`，使 **Pseudo IPv4** 处于 **Off** 或 **Add Header**，并让请求直接走 Tunnel 路由，避免受会改写访客 IP 的中间层或 Worker 影响。[Pseudo IPv4](https://developers.cloudflare.com/network/pseudo-ipv4/) · [Worker 子请求的访客 IP](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip)
- 给此域名的全部路径设 **Bypass cache**，并按域名清除以前存下的 Cloudflare 缓存。这样页面、API 和静态文件的请求都会到应用检查白名单。应用会返回 `Cloudflare-CDN-Cache-Control: no-store`，Cloudflare 的缓存规则仍可覆盖源站的缓存策略。[缓存规则设置](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/#cache-eligibility) · [缓存头优先级](https://developers.cloudflare.com/cache/concepts/cdn-cache-control/) · [按域名清除缓存](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-hostname/)

## 管理后台操作

- 添加：CIDR + 标签 + 可选到期时间；需要再次输入管理员密码。
- 启用/停用/删除：同样需要二次密码；写审计（操作者、前后值、时间、结果、IP）。
- **锁死保护**：若停用/删除/改规则会导致“当前请求 IP 不再被任何启用规则覆盖”，返回 `409 LOCKOUT_RISK`，必须先添加替代规则。
- 列表展示 active/expired/disabled、最后命中时间、创建者。
- 变更后应用异步调用 `edge-sync.ts`：若配置 `NGINX_ALLOWLIST_PATH`，原子写入 `allow ...; deny all;`，可选执行 `NGINX_RELOAD_CMD`。Compose 使用 `auth_request`，无需此文件/reload。

## 静态 allowlist（可选）

适用于希望 Nginx 在应用挂掉时仍能按文件拒绝的方案：

```bash
npm run sync:nginx -- --out /etc/nginx/family-ai-chat/ip-allow.conf
# 在 server{} 中 include /etc/nginx/family-ai-chat/ip-allow.conf;
# 变更后：
npm run sync:nginx -- --reload
```

注意：静态文件需要 reload 才生效，且应用故障时可能过期；本项目默认 Compose 配置使用动态 `auth_request`，更安全。

## nftables

`npm run sync:firewall` 从数据库生成 `deploy/nftables/family-ai-chat.generated.nft`，包含：

- `web_allow_v4` / `web_allow_v6` 集合；
- loopback 放行；
- `tcp dport 3000 drop`；
- 仅集合内来源可访问 80/443，其余丢弃；
- 不触碰 SSH（input policy accept，只对 80/443/3000 加规则）。

```bash
npm run sync:firewall                 # 仅生成 + 语法检查
sudo nft -f deploy/nftables/family-ai-chat.generated.nft
# 或确认控制台可用后：npm run sync:firewall -- --apply
```

不要在只有 SSH 且没有带外控制台的情况下直接 apply；先确认当前 IP 在集合内。恢复：

```bash
sudo nft list table inet family_ai_chat
sudo nft delete table inet family_ai_chat
```

## 云安全组

- 入站：80/443 仅允许可信公网 IP/CIDR；22 仅管理 IP；其他全部拒绝。
- 出站：限制到 PostgreSQL（如本机）、SMTP、AI Provider；不需要全开。
- IPv6 同样配置；不要只配 IPv4。
- 修改前记录当前 IP，保留云厂商 Web 控制台/串口控制台。
- 本项目不购买、不修改任何云资源；以上需在你自己账号中完成。

## 恢复被锁在门外

1. **应用层**：服务器控制台执行 `npx tsx scripts/emergency.ts --allow-ip <你的IP>`；Compose 无需 reload，裸机静态 include 需 `npm run sync:nginx -- --reload`。
2. **Nginx 静态层**：临时编辑 include 文件加入 `allow <IP>;` 后 `nginx -s reload`；或先注释 `include` 再 reload。
3. **nftables**：`sudo nft delete table inet family_ai_chat`。
4. **云安全组**：用云控制台加回 IP。
5. **忘记密码**：`scripts/emergency.ts --reset-owner-password`。

所有应急操作都写审计，且不需要 Web 登录。

## 验证证据

集成测试覆盖：

- 允许 IP 访问 `/api/health`、页面与静态资源；
- 未列出的 `127.0.0.2` 在登录前被 403（API、根路径、`_next/static`）；
- 伪造 `X-Real-IP` / `X-Forwarded-For` 仍被拒绝；
- 添加规则后立即允许；临时规则到期后拒绝；删除规则立即拒绝；
- 试图停用最后一条覆盖当前 IP 的规则返回 `409 LOCKOUT_RISK`；
- IPv4 / IPv6 / IPv4-mapped CIDR 规范化与匹配（单元测试）；
- Nginx `auth_request` 在真实 Nginx 1.18 上验证：允许 IP 200，未允许 IP 403，HTTP 301，HSTS 单头。

## 常见问题

- **所有请求 403**：检查是否有匹配客户端公网 IP 的启用规则。在普通代理模式下，检查 TCP 对端是否可信，代理是否写入了单个 `X-Real-IP`。在同机 Tunnel 模式下，检查 `WINDOWS_PROXY_PROVIDER`、回源地址和 `CF-Connecting-IP`。
- **规则加了不生效**：检查 `expiresAt`、`enabled`、CIDR 是否被规范化成不同网段；等待 `IP_CACHE_MS`。
- **Nginx 全部 500/403**：`auth_request` 到应用的 `/api/health` 失败；先 `curl 127.0.0.1:3000/api/health`。应用故障时 fail closed 是预期行为。
- **IPv6 用户被拒**：只加了 IPv4 规则；补充 IPv6 或 `::/0`（不推荐）。
