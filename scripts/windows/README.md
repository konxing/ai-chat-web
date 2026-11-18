# AI WebChat Windows 管理程序

首次双击时，如果项目目录还没有 `.env`，会打开初始化向导。先安装 Node.js 和项目依赖，并准备可连接的空 PostgreSQL 数据库。向导会检查数据库、应用迁移、构建网站并创建管理员。完成后点击「启动并打开聊天」，进入浏览器登录。已有 `.env` 的安装直接进入管理窗口。

在「连接 PostgreSQL」一步，库名填 pgAdmin 中创建的数据库名称。分项填写时，向导会处理账号和密码里的特殊字符。已有完整连接地址时，可切换到高级选项。附件和备份可选其他本机磁盘，数据库文件的位置由 PostgreSQL 的数据目录决定。

如果初始化失败，可根据窗口提示修正后重试。构建或迁移失败时，可在项目的 `dist/windows/setup-error.log` 查看详情。请保留初始化产生的 `.env.windows-setup.local`，重试时会沿用其中的密钥。

在项目根目录双击 `AI WebChat.exe`，点击「启动服务」。窗口显示「正在运行」后，点击「打开聊天」。同一个 EXE 也负责在后台启动网站，运行时不会弹出命令窗口。关闭浏览器或管理窗口后，服务会继续运行。管理窗口可以停止服务或查看「运行日志」。

后台由 Windows 任务计划程序以当前账号管理。「随 Windows 登录启动」可以开启或关闭。注销或重启会结束本次运行。程序依赖本机的 Node.js、项目依赖和 PostgreSQL 服务。

## 更新已安装的项目

1. 用旧版管理窗口点「停止」，等服务停止后关闭管理窗口。如果原来在终端启动过另一个实例，先在那个终端按 `Ctrl+C` 停止。
2. 在含有 `package.json` 的项目根目录打开 PowerShell，拉取最新代码（已经拉取可以跳过），并依次执行下面的命令。

   ```powershell
   git pull --ff-only
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\build.ps1
   ```

3. 构建脚本先检查已安装的项目依赖。依赖完整且与 `package-lock.json` 一致时显示「skipping installation」，直接跳过安装；有缺失、版本变化或检查未通过时，才自动安装锁定版本的完整依赖。随后构建网站、执行数据库迁移并重新生成 `AI WebChat.exe`。安装依赖失败时会停止并显示具体错误，修正后可重新运行同一条构建命令。这个命令不会安装 Node.js 或 PostgreSQL。保留原有的 `.env`、附件和数据库。更新后双击 EXE，点「启动服务 → 打开聊天」。

本机默认地址为 `http://127.0.0.1:3000`。登录自启沿用旧任务的配置。启动失败可以查看 `dist/windows/backend.log`。

## 本机使用与反向代理

EXE 默认只供本机浏览器使用。旧版 `.env` 里的 `TRUST_PROXY` 或公网 `ALLOWED_ORIGINS` 无需为本机使用而修改。本机模式只接受 127.0.0.1 或 localhost 的浏览器入口。不要用端口映射或透明 TCP 隧道把本机入口对外开放，这类转发无法提供可信客户端身份。

经普通 HTTPS 反向代理访问时，在 `.env` 设置 `WINDOWS_USE_PROXY=true`、`APP_URL=https://你的公开域名`，并将 `TRUSTED_PROXY_CIDRS` 设为代理连接后端的确切地址。同机代理连接 IPv4 的配置为 `TRUSTED_PROXY_CIDRS=127.0.0.1/32`。此模式使用默认的 `WINDOWS_PROXY_PROVIDER=generic`，代理按示例覆盖 `X-Real-IP`。重启后，在浏览器打开配置的 HTTPS 地址。[Nginx 配置示例](../../deploy/nginx/proxy-common.conf)

如果旧配置已有 `127.0.0.1` 登录锁，使用已登录的管理员会话，进入「管理后台 → 访问控制 → IP 白名单 → 登录失败锁定」，找到对应 IP 并点击「解除」。没有可用的管理员会话时，等待锁定期满 5 分钟再登录。

## Cloudflare Tunnel 与 EXE 同机运行

`cloudflared` 可以直接连接同一台 Windows 电脑上的 AI WebChat。浏览器从 HTTPS 域名进入，Tunnel 的回源地址使用本机 HTTP 回环端口。

1. 在当前仍可登录的管理后台中，把日常访问网站所用的**公网 IPv4 或 IPv6**加入 IP 白名单。保留 `127.0.0.1/32` 供 Windows 启动器检查服务状态。宽带、手机流量和 VPN 可能使用不同的出口 IP。
2. 在项目根目录的 `.env` 中修改以下同名项。域名示例为 `stepmark.xin`，换用其他域名时同步修改 Tunnel 路由。

   ```env
   WINDOWS_USE_PROXY=true
   WINDOWS_PROXY_PROVIDER=cloudflare
   APP_URL=https://stepmark.xin
   TRUSTED_PROXY_CIDRS=127.0.0.1/32
   ```

3. 在运行 EXE 的 Windows 主机上保持现有 `cloudflared` 运行。在 Tunnel 中设置 **Published application** 路由，域名填 `stepmark.xin`，服务使用 **HTTP**，回源地址为 `http://127.0.0.1:3000`。保留来自公网地址的 `Host`；如需指定，在该路由的 **Additional application settings → HTTP → HTTP Host Header** 填 `stepmark.xin`。[Cloudflare Tunnel 设置](https://developers.cloudflare.com/tunnel/get-started/#publish-an-application) · [回源 Host 设置](https://developers.cloudflare.com/tunnel/reference/origin-parameters/#httphostheader)
4. 保持端口 3000 仅监听 Windows 本机回环，路由器和防火墙保持关闭该端口的外部入站访问。让 `cloudflared` 直接连接 EXE 后端，保持这一段转发路径只有一个代理。[来源 IP 的信任条件](../../docs/IP_WHITELIST.md#cloudflare-tunnel-同机直连)
5. 在 Cloudflare 为该域名创建一条 **Cache Rule**。匹配条件为 `http.host eq "stepmark.xin"`，缓存资格选 **Bypass cache**。若有其他规则也匹配此域名，请让这条规则最后生效。若此站曾被缓存，按域名清除历史缓存。[缓存规则设置](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/#cache-eligibility) · [规则优先级](https://developers.cloudflare.com/cache/how-to/cache-rules/order/) · [按域名清除缓存](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-hostname/)
6. 用 EXE 停止并重新启动服务。窗口显示「正在运行」后，从已获准的网络打开 `https://stepmark.xin`。再从一个未获准的网络访问同一地址，确认在登录页出现前收到 403。

若域名返回 403，先核对浏览器出口 IP 是否在白名单中，再检查 Tunnel 是否把有效的 `CF-Connecting-IP` 传到后端。Cloudflare 的访客 IP 移除规则应关闭，**Pseudo IPv4** 可用 **Off** 或 **Add Header**，以保留真实 IPv6。启动器显示「正在运行」表示本机健康检查通过，Tunnel 可用性以上述域名访问结果为准。[Cloudflare 请求头](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip) · [Pseudo IPv4 设置](https://developers.cloudflare.com/network/pseudo-ipv4/)

## Cloudflare Tunnel 经 Caddy 同机转发

在运行 EXE 的同一台 Windows 主机安装 Caddy。访问路径为 Cloudflare Tunnel → Caddy（`127.0.0.1:8080`）→ AI WebChat（`127.0.0.1:3000`）。浏览器继续访问原 HTTPS 域名。访问白名单、`.env` 中的四项 Cloudflare 设置和缓存规则沿用上一节。

1. 在 PowerShell 进入项目目录并拉取更新。示例项目位于 `E:\ai_chat_web`。

   ```powershell
   cd 'E:\ai_chat_web'
   git pull --ff-only
   winget install --exact --id CaddyServer.Caddy --source winget
   ```

   如果当前 EXE 还不支持 `WINDOWS_PROXY_PROVIDER=cloudflare`，先按[更新已安装的项目](#更新已安装的项目)重新构建。已有该模式的安装拉取 Caddy 配置即可。

2. 重新打开 PowerShell，运行下面的命令。将 `stepmark.xin` 换成自己的域名，须与 `.env` 中的 `APP_URL` 及 Tunnel 路由一致。配置检查通过后，Caddy 会在后台启动。

   ```powershell
   cd 'E:\ai_chat_web'
   $env:WEBCHAT_CADDY_HOST = 'stepmark.xin'
   $caddyPath = (Get-Command caddy.exe -CommandType Application -ErrorAction Stop).Source
   $caddyConfig = (Resolve-Path -LiteralPath '.\deploy\caddy\Caddyfile').Path
   & $caddyPath validate --config $caddyConfig --adapter caddyfile
   if ($LASTEXITCODE -eq 0) {
       Start-Process -FilePath $caddyPath `
           -ArgumentList "run --config `"$caddyConfig`" --adapter caddyfile" `
           -WindowStyle Hidden
   }
   ```

   Caddy 每次开机启动一次。要手动停止，运行 `caddy.exe stop --address 127.0.0.1:2021`。浏览器关闭后，Caddy 继续在后台运行。[Caddy 命令](https://caddyserver.com/docs/command-line)

3. 在 Cloudflare 的 Tunnel 中编辑现有 **Published application**。服务类型选 **HTTP**，地址改为 `127.0.0.1:8080`。**HTTP Host Header** 留空，或填 `stepmark.xin`。保持浏览器走 HTTPS，域名继续使用 **Bypass cache**，并保持 Cloudflare 访客 IP 请求头和真实 IPv6。[Cloudflare 回源设置](https://developers.cloudflare.com/tunnel/reference/origin-parameters/) · [HTTPS 跳转](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/)

4. 如果只允许指定人员访问，在 Cloudflare Access 为整个域名创建 **Self-hosted** 应用，配置只允许指定身份的策略。随后在同一条 Tunnel 路由的 **Additional application settings → Access** 打开 **Protect with Access**，选对应团队和应用。这样 `cloudflared` 会在转发给 Caddy 前验证 Access 登录凭据。网站仍检查访客 IP 白名单和站内账号。[Cloudflare Access 配置](https://developers.cloudflare.com/reference-architecture/design-guides/identity-gated-edge/)

5. 双击 EXE 并启动服务。用已获准的网络访问 HTTPS 域名，确认能登录和流式聊天。再用未获准的身份或网络确认被拒绝。防火墙和路由器保持关闭 `2021`、`3000`、`8080` 的外部入站访问。Caddy 与后端的回环端口信任同机进程，部署主机应由你控制。[来源 IP 的信任条件](../../docs/IP_WHITELIST.md#cloudflare-tunnel-经-caddy-同机转发)
