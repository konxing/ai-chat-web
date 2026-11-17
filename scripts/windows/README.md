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
   git pull
   npm.cmd ci --include=dev
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\build.ps1
   ```

3. 构建脚本会构建网站、执行数据库迁移并重新生成 `AI WebChat.exe`。保留原有的 `.env`、附件和数据库。更新后双击 EXE，点「启动服务 → 打开聊天」。

本机默认地址为 `http://127.0.0.1:3000`。登录自启沿用旧任务的配置。启动失败可以查看 `dist/windows/backend.log`。

## 本机使用与反向代理

EXE 默认只供本机浏览器使用。旧版 `.env` 里的 `TRUST_PROXY` 或公网 `ALLOWED_ORIGINS` 无需为本机使用而修改。本机模式只接受 127.0.0.1 或 localhost 的浏览器入口。不要用端口映射或透明 TCP 隧道把本机入口对外开放，这类转发无法提供可信客户端身份。

确实需要经 HTTPS 反向代理访问时，在 `.env` 设置 `WINDOWS_USE_PROXY=true`、`APP_URL=https://你的公开域名`，并将 `TRUSTED_PROXY_CIDRS` 设为代理连接后端的确切地址。同机代理连接 IPv4 的配置为 `TRUSTED_PROXY_CIDRS=127.0.0.1/32`。让代理按 [Nginx 配置示例](../../deploy/nginx/proxy-common.conf) 覆盖 `X-Real-IP`。重启后，在浏览器打开配置的 HTTPS 地址。

如果旧配置已有 `127.0.0.1` 登录锁，使用已登录的管理员会话，进入「管理后台 → 访问控制 → IP 白名单 → 登录失败锁定」，找到对应 IP 并点击「解除」。没有可用的管理员会话时，等待锁定期满 5 分钟再登录。
