# IP 白名单与网络边界

目标：任何未被明确授权的 IP，在到达登录页、动画、API、静态资源或聊天之前就被拒绝。**默认拒绝，失败关闭**。

## 四层防护

| 层 | 位置 | 作用 | 动态性 |
| --- | --- | --- | --- |
| 1 | 云安全组 / 防火墙 | 只放行家庭 IP 到 80/443；SSH 仅管理 IP | 云控制台变更 |
| 2 | nftables | 主机层默认丢弃 80/443，直连 3000 丢弃 | `sync:firewall` 生成，`--apply` 生效 |
| 3 | Nginx | TLS、限速、`auth_request /_ip_gate` 动态询问应用 | 立即（应用缓存 ≤ `IP_CACHE_MS`） |
| 4 | Node `server.js` | 所有请求（含 `_next/static`、API、健康检查）先过白名单 | 立即（缓存 ≤ 1s） |

应用层是最终底线；即使 Nginx 配置错误、静态资源被单独暴露，未授权 IP 仍会得到 403。

## 规则模型

- 支持 IPv4、IPv6、CIDR；入库前规范化（IPv4-mapped IPv6 转为 IPv4，CIDR 网络地址掩码化）。
- 多条规则取并集；`enabled=false` 或 `expiresAt <= now` 不参与匹配。
- 临时访问：设置到期时间，到期后自动失效（无需重启/清理任务）。
- 默认拒绝：没有匹配规则即 403；数据库不可用超过 5 秒返回 503（不会放行）。
- 白名单缓存默认 1000ms（`IP_CACHE_MS`，最小 200ms）；删除/停用规则最迟约 1 秒生效。

## 真实客户端 IP 与可信代理

`server.js` 只信任 TCP peer 的地址；只有当 peer 属于 `TRUSTED_PROXY_CIDRS` 时才读取 `X-Real-IP`：

```env
TRUST_PROXY=true
TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128   # 裸机 Nginx
# Compose: 172.28.0.10/32（Nginx 容器静态地址）
```

随后删除 `Forwarded`、`X-Forwarded-For`、`X-Real-IP`，写入可信的 `x-real-ip` / `x-client-ip`。因此：

- 外部伪造 `X-Real-IP: 127.0.0.1` 无效（来源不在可信代理列表）；
- 经过 Nginx 的真实客户端 IP 被正确识别；
- 不要在 Nginx 之前再加一层代理却不更新 `TRUSTED_PROXY_CIDRS`；Cloudflare 等 CDN 需要额外校验其回源地址，当前未内置 CDN 适配。

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

- 入站：80/443 仅允许家庭公网 IP/CIDR；22 仅管理 IP；其他全部拒绝。
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

- **所有请求 403**：没有任何启用规则，或 `TRUSTED_PROXY_CIDRS` 不包含 Nginx 地址导致真实 IP 取成容器 IP。
- **规则加了不生效**：检查 `expiresAt`、`enabled`、CIDR 是否被规范化成不同网段；等待 `IP_CACHE_MS`。
- **Nginx 全部 500/403**：`auth_request` 到应用的 `/api/health` 失败；先 `curl 127.0.0.1:3000/api/health`。应用故障时 fail closed 是预期行为。
- **IPv6 用户被拒**：只加了 IPv4 规则；补充 IPv6 或 `::/0`（不推荐）。
