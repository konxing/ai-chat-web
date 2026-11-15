using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Threading.Tasks;
using System.Windows.Forms;

internal static class Launcher
{
    private const string Address = "http://127.0.0.1:3000";
    private static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;
    private static readonly string Log = Path.Combine(Root, "dist", "windows", "backend.log");

    private static readonly Color Navy = Color.FromArgb(20, 33, 49);
    private static readonly Color Muted = Color.FromArgb(66, 85, 102);

    private static void StyleWindow(Form window)
    {
        window.AutoScaleMode = AutoScaleMode.Dpi;
        window.Font = new Font("Microsoft YaHei UI", 10);
        window.BackColor = Color.FromArgb(238, 243, 248);
        window.ForeColor = Navy;
        window.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
    }

    private static Label Heading(string text)
    {
        return new Label { Text = text, Dock = DockStyle.Top, Height = 46,
            Font = new Font("Microsoft YaHei UI", 19, FontStyle.Bold), ForeColor = Navy };
    }

    private static Button ActionButton(string text, bool primary = false)
    {
        var button = new Button { Text = text, AutoSize = true, Height = 36, MinimumSize = new Size(106, 36),
            Padding = new Padding(8, 0, 8, 0), FlatStyle = FlatStyle.Flat,
            BackColor = primary ? Color.FromArgb(0, 106, 92) : Color.White,
            ForeColor = primary ? Color.White : Navy };
        button.FlatAppearance.BorderColor = Color.FromArgb(186, 201, 212);
        return button;
    }

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new Dashboard());
    }

    private sealed class Dashboard : Form
    {
        private readonly Label status = new Label { AutoSize = true, Text = "正在检查后端…" };
        private readonly FlowLayoutPanel actions = new FlowLayoutPanel { AutoSize = true, WrapContents = true, Dock = DockStyle.Top };
        private readonly Timer timer = new Timer { Interval = 3000 };
        private bool busy;
        private bool probing;

        public Dashboard()
        {
            Text = "AI WebChat 管理";
            ClientSize = new Size(620, 230);
            MinimumSize = new Size(520, 265);
            StyleWindow(this);
            StartPosition = FormStartPosition.CenterScreen;
            Padding = new Padding(18);
            var header = Heading("AI WebChat");
            var caption = new Label { Text = "管理本机聊天服务 · 网页会在默认浏览器打开", Dock = DockStyle.Top, Height = 34, ForeColor = Muted };
            var state = new Panel { Dock = DockStyle.Top, Height = 34 };
            state.Controls.Add(status);
            Controls.Add(actions);
            Controls.Add(state);
            Controls.Add(caption);
            Controls.Add(header);
            AddAction("启动", async () => await Run("Start"));
            AddAction("停止", async () => await Run("Stop"));
            actions.SetFlowBreak(AddAction("打开聊天", () => Open(Address)), true);
            AddAction("开启登录自启", async () => await Run("Enable"));
            AddAction("关闭登录自启", async () => await Run("Disable"));
            AddAction("查看日志", () => Open(Log));
            timer.Tick += async (sender, args) => await RefreshStatus();
            Shown += async (sender, args) =>
            {
                timer.Start();
                if (!File.Exists(Path.Combine(Root, ".env")))
                {
                    using (var setup = new SetupDialog())
                    {
                        if (setup.ShowDialog(this) == DialogResult.OK)
                        {
                            if (!await Run("Start")) return;
                            for (int attempt = 0; attempt < 30 && !IsDisposed; attempt++)
                            {
                                if ((await Task.Run((Func<string>)ReadStatus)).StartsWith("正在运行"))
                                {
                                    Open(Address + "/login?setup=complete");
                                    return;
                                }
                                await Task.Delay(500);
                            }
                            if (!IsDisposed) MessageBox.Show(this, "初始化已保存，但服务尚未就绪。请查看管理窗口和运行日志。", "AI WebChat");
                        }
                    }
                }
                await RefreshStatus();
            };
            FormClosed += (sender, args) => timer.Dispose();
        }

        private Button AddAction(string title, Action click)
        {
            var button = ActionButton(title, title == "启动");
            button.Click += (sender, args) => click();
            actions.Controls.Add(button);
            return button;
        }

        private async Task<bool> Run(string action)
        {
            if (busy) return false;
            busy = true;
            actions.Enabled = false;
            status.Text = "正在执行，请稍候…";
            string result = null;
            bool succeeded = false;
            try
            {
                await Task.Run(() => InvokeTask(action));
                result = action == "Enable" ? "登录自启已开启" : action == "Disable" ? "登录自启已关闭" : null;
                succeeded = true;
            }
            catch (Exception error)
            {
                if (!IsDisposed) MessageBox.Show(this, error.Message, "AI WebChat", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            finally
            {
                busy = false;
                if (!IsDisposed)
                {
                    actions.Enabled = true;
                }
            }
            await RefreshStatus();
            if (result != null && !IsDisposed) status.Text += " · " + result;
            return succeeded;
        }

        private async Task RefreshStatus()
        {
            if (busy || probing || IsDisposed) return;
            probing = true;
            try
            {
                string current = await Task.Run((Func<string>)ReadStatus);
                if (!IsDisposed && !busy) status.Text = current;
            }
            finally { probing = false; }
        }

        private void Open(string target)
        {
            if (target == Log && !File.Exists(Log))
            {
                MessageBox.Show(this, "首次启动后可查看日志。", "AI WebChat");
                return;
            }
            try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); }
            catch (Exception error) { MessageBox.Show(this, error.Message, "AI WebChat"); }
        }
    }

    private sealed class SetupDialog : Form
    {
        private readonly TextBox host = new TextBox { Text = "127.0.0.1" };
        private readonly TextBox port = new TextBox { Text = "5432", MaxLength = 5 };
        private readonly TextBox dbName = new TextBox { Text = "ai_webchat" };
        private readonly TextBox dbUser = new TextBox { Text = "postgres" };
        private readonly TextBox dbPassword = new TextBox { UseSystemPasswordChar = true };
        private readonly TextBox databaseUrl = new TextBox { UseSystemPasswordChar = true };
        private readonly TextBox storage = new TextBox();
        private readonly TextBox username = new TextBox { Text = "admin" };
        private readonly TextBox email = new TextBox();
        private readonly TextBox password = new TextBox { UseSystemPasswordChar = true };
        private readonly TextBox confirmation = new TextBox { UseSystemPasswordChar = true };
        private readonly CheckBox advanced = new CheckBox { Text = "使用完整连接地址", AutoSize = true };
        private readonly Label title = Heading("");
        private readonly Label header;
        private readonly Label description = new Label { Dock = DockStyle.Top, Height = 68, ForeColor = Muted };
        private readonly Label detail = new Label { Dock = DockStyle.Fill, ForeColor = Muted };
        private readonly Label errorLabel = new Label { Dock = DockStyle.Top, Height = 48, ForeColor = Color.FromArgb(170, 38, 53) };
        private readonly ProgressBar progress = new ProgressBar { Dock = DockStyle.Top, Height = 12, Maximum = 5 };
        private readonly Button next = ActionButton("下一步", true);
        private readonly Button back = ActionButton("上一步");
        private readonly Panel body = new Panel { Dock = DockStyle.Fill, BackColor = Color.White, Padding = new Padding(24) };
        private readonly TableLayoutPanel basicFields = FormFields();
        private readonly TableLayoutPanel advancedFields = FormFields();
        private readonly Panel databaseFields = new Panel { Dock = DockStyle.Fill };
        private readonly TableLayoutPanel ownerFields = FormFields();
        private int page;
        private bool running;
        private bool complete;
        private bool reuseDatabase;
        private string database;

        public SetupDialog()
        {
            Text = "AI WebChat · 首次运行";
            StartPosition = FormStartPosition.CenterParent;
            StyleWindow(this);
            ClientSize = new Size(650, 580);
            MinimumSize = new Size(620, 550);
            header = new Label
            {
                Dock = DockStyle.Top, Height = 64,
                BackColor = Navy, ForeColor = Color.White, TextAlign = ContentAlignment.MiddleLeft,
                Padding = new Padding(24, 0, 0, 0), Font = new Font(Font, FontStyle.Bold)
            };
            var footer = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Bottom, Height = 66,
                Padding = new Padding(18, 12, 18, 0)
            };
            footer.Controls.Add(next);
            footer.Controls.Add(back);
            body.Controls.Add(detail);
            body.Controls.Add(ownerFields);
            body.Controls.Add(databaseFields);
            body.Controls.Add(progress);
            body.Controls.Add(errorLabel);
            body.Controls.Add(description);
            body.Controls.Add(title);
            Controls.Add(body);
            Controls.Add(footer);
            Controls.Add(header);

            AddField(basicFields, "主机", host);
            AddField(basicFields, "端口", port);
            AddField(basicFields, "数据库名", dbName);
            AddField(basicFields, "数据库用户名", dbUser);
            AddField(basicFields, "数据库密码", dbPassword);
            AddSpacer(basicFields);
            AddField(advancedFields, "连接地址", databaseUrl);
            AddSpacer(advancedFields);
            var storageFields = FormFields();
            storageFields.Dock = DockStyle.Bottom;
            storageFields.Height = 56;
            var storagePicker = ActionButton("浏览…");
            storagePicker.AutoSize = false;
            storagePicker.MinimumSize = Size.Empty;
            storagePicker.Size = new Size(74, 31);
            storagePicker.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            storagePicker.Click += (sender, args) =>
            {
                using (var folder = new FolderBrowserDialog { Description = "选择附件和备份的存放目录" })
                {
                    if (Directory.Exists(storage.Text)) folder.SelectedPath = storage.Text;
                    if (folder.ShowDialog(this) == DialogResult.OK) storage.Text = folder.SelectedPath;
                }
            };
            var storageRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Margin = Padding.Empty };
            storageRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            storageRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 82));
            storageRow.Controls.Add(storage, 0, 0);
            storageRow.Controls.Add(storagePicker, 1, 0);
            storageFields.RowCount++;
            storageFields.RowStyles.Add(new RowStyle(SizeType.Absolute, 41));
            storageFields.Controls.Add(new Label { Text = "附件与备份目录", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 0);
            storageFields.Controls.Add(storageRow, 1, 0);
            storage.Dock = DockStyle.Top;
            storage.AccessibleName = "附件与备份目录";
            AddSpacer(storageFields);
            storage.AccessibleDescription = "可选，填写如 D:\\AIWebChat；留空使用项目目录。";
            databaseFields.Controls.Add(basicFields);
            databaseFields.Controls.Add(advancedFields);
            databaseFields.Controls.Add(storageFields);
            advanced.Dock = DockStyle.Top;
            databaseFields.Controls.Add(advanced);
            advanced.CheckedChanged += (sender, args) => ShowPage(1);
            AddField(ownerFields, "管理员用户名", username);
            AddField(ownerFields, "管理员邮箱", email);
            AddField(ownerFields, "登录密码", password);
            AddField(ownerFields, "确认登录密码", confirmation);
            AddSpacer(ownerFields);
            AcceptButton = next;
            FormClosing += (sender, args) => { if (running) args.Cancel = true; };
            back.Click += (sender, args) => ShowPage(page == 3 ? 2 : page - 1);
            next.Click += async (sender, args) => await Advance();
            ShowPage(0);
        }

        private void ShowPage(int index)
        {
            page = index;
            reuseDatabase = File.Exists(Path.Combine(Root, ".env.windows-setup.local"));
            header.Text = "AI WebChat   /   首次运行   ·   " + (page + 1) + " / 4";
            title.Text = new[] { "准备安装", "连接 PostgreSQL", "创建管理员", "初始化网站" }[page];
            description.Text = new[] {
                "开始前请准备 Node.js 22.12 或更高的兼容版本、项目依赖，以及 PostgreSQL 中的空数据库。",
                "数据库名填你在 pgAdmin 里创建的名称。附件与备份目录可以留空，也可以填写 D:\\AIWebChat 等路径。",
                "这个账号用来登录 AI WebChat。设定 10–128 字符的密码，并至少使用两类字符。",
                "将依次检查数据库、应用迁移、构建网页、创建管理员并保存配置。首次构建需要一些时间。"
            }[page];
            detail.Text = page == 0
                ? "• 在项目目录运行 npm.cmd ci --include=dev 安装依赖。\n\n• 在 pgAdmin 的 Databases 下创建空库。\n\n• 确认 PostgreSQL 已启动，记住数据库账号和密码。"
                : "";
            if (page == 1 && reuseDatabase)
                description.Text = "找到上次的初始化配置。请保持 PostgreSQL 运行，继续使用已保存的连接和存储目录。";
            if (page == 3) description.Text = "首次构建需要一些时间。初始化完成后可启动本地服务。";
            detail.Visible = page == 0 || page == 3;
            databaseFields.Visible = page == 1 && !reuseDatabase;
            basicFields.Visible = page == 1 && !advanced.Checked;
            advancedFields.Visible = page == 1 && advanced.Checked;
            ownerFields.Visible = page == 2;
            progress.Visible = page == 3;
            back.Visible = page > 0 && !complete;
            back.Enabled = !running;
            next.Text = running ? "正在初始化…" : complete ? "启动并打开聊天" : page < 2 ? "下一步" : page == 2 ? "开始初始化" : "重试";
            next.Enabled = !running;
            errorLabel.Visible = false;
        }

        private async Task Advance()
        {
            if (running) return;
            if (complete) { DialogResult = DialogResult.OK; return; }
            if (page == 0)
            {
                if (!File.Exists(Path.Combine(Root, "node_modules", "prisma", "build", "index.js")))
                {
                    ShowError("缺少项目依赖，请先在项目目录运行 npm.cmd ci --include=dev。");
                    return;
                }
                ShowPage(1);
                return;
            }
            if (page == 1)
            {
                try { database = reuseDatabase ? null : ReadDatabase(); }
                catch (ArgumentException error) { ShowError(error.Message); return; }
                ShowPage(2);
                return;
            }
            if (password.Text != confirmation.Text || password.TextLength < 10 || password.TextLength > 128 ||
                !Regex.IsMatch(username.Text.Trim(), @"^[a-zA-Z0-9_一-龥-]{3,32}$") ||
                !Regex.IsMatch(email.Text.Trim(), @"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$"))
            {
                ShowError("请检查用户名（3–32 个字符）、邮箱和两次输入的登录密码。");
                return;
            }
            running = true;
            ShowPage(3);
            progress.Value = 0;
            detail.Text = "正在启动初始化…";
            var reporter = new Progress<string>(line =>
            {
                if (!running || IsDisposed) return;
                var parts = line.Split(new[] { ':' }, 3);
                int stage;
                if (parts.Length == 3 && parts[0] == "STEP" && int.TryParse(parts[1], out stage) && stage >= 1 && stage <= 5)
                {
                    progress.Value = stage - 1;
                    detail.Text = stage + " / 5   " + parts[2];
                }
            });
            try
            {
                var input = new JavaScriptSerializer().Serialize(new {
                    database = database, username = username.Text.Trim(),
                    email = email.Text.Trim(), password = password.Text,
                    storageDirectory = reuseDatabase ? "" : storage.Text.Trim(),
                    reuseDatabase = reuseDatabase
                });
                await Task.Run(() => RunSetup(input, reporter));
                password.Clear();
                confirmation.Clear();
                dbPassword.Clear();
                databaseUrl.Clear();
                database = null;
                complete = true;
                progress.Value = 5;
                detail.Text = "数据库和管理员已就绪。点击下方按钮启动本地服务并进入登录页。";
            }
            catch (Exception error)
            {
                detail.Text = error.Message;
            }
            finally
            {
                running = false;
                next.Enabled = true;
                next.Text = complete ? "启动并打开聊天" : "重试";
                back.Visible = !complete;
                back.Enabled = true;
            }
        }

        private string ReadDatabase()
        {
            if (advanced.Checked)
            {
                string value = databaseUrl.Text.Trim();
                if (!value.StartsWith("postgresql://", StringComparison.Ordinal) && !value.StartsWith("postgres://", StringComparison.Ordinal))
                    throw new ArgumentException("请输入以 postgresql:// 开头的连接地址。");
                return value;
            }
            int number;
            string server = host.Text.Trim();
            if (Uri.CheckHostName(server.Trim('[', ']')) == UriHostNameType.Unknown ||
                !int.TryParse(port.Text, out number) || number < 1 || number > 65535 ||
                String.IsNullOrWhiteSpace(dbName.Text) || String.IsNullOrWhiteSpace(dbUser.Text))
                throw new ArgumentException("请检查主机、端口、数据库名和数据库用户名。");
            if (server.Contains(":")) server = "[" + server.Trim('[', ']') + "]";
            return "postgresql://" + EscapeDatabaseComponent(dbUser.Text.Trim()) + ":" +
                EscapeDatabaseComponent(dbPassword.Text) + "@" + server + ":" + number + "/" +
                EscapeDatabaseComponent(dbName.Text.Trim());
        }

        private static string EscapeDatabaseComponent(string value)
        {
            return Uri.EscapeDataString(value).Replace("'", "%27");
        }

        private void ShowError(string message)
        {
            errorLabel.Text = message;
            errorLabel.Visible = true;
        }
    }

    private static TableLayoutPanel FormFields()
    {
        var panel = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, AutoScroll = true };
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 145));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        return panel;
    }

    private static void AddField(TableLayoutPanel panel, string name, TextBox box)
    {
        int row = panel.RowCount;
        panel.RowCount++;
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 35));
        panel.Controls.Add(new Label { Text = name, AutoSize = true, Anchor = AnchorStyles.Left }, 0, row);
        box.Dock = DockStyle.Top;
        box.AccessibleName = name;
        panel.Controls.Add(box, 1, row);
    }

    private static void AddSpacer(TableLayoutPanel panel)
    {
        panel.RowCount++;
        panel.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
    }

    private static void RunSetup(string input, IProgress<string> progress)
    {
        if (!File.Exists(Path.Combine(Root, "node_modules", "prisma", "build", "index.js")))
            throw new InvalidOperationException("缺少项目依赖，请先准备完整的 AI WebChat 项目目录。");
        var start = new ProcessStartInfo("node.exe", "scripts/windows/setup.cjs") {
            WorkingDirectory = Root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardError = true, RedirectStandardOutput = true,
            StandardErrorEncoding = Encoding.UTF8, StandardOutputEncoding = Encoding.UTF8
        };
        Process child;
        try { child = Process.Start(start); }
        catch (Win32Exception error)
        {
            if (error.NativeErrorCode != 2) throw;
            throw new InvalidOperationException("找不到 Node.js。请安装 Node.js，并重新打开 AI WebChat 后重试。");
        }
        using (var process = child)
        {
            process.OutputDataReceived += (sender, args) => { if (args.Data != null) progress.Report(args.Data); };
            process.BeginOutputReadLine();
            byte[] payload = Encoding.UTF8.GetBytes(input);
            process.StandardInput.BaseStream.Write(payload, 0, payload.Length);
            process.StandardInput.Close();
            string error = process.StandardError.ReadToEnd().Trim();
            process.WaitForExit();
            if (process.ExitCode != 0)
                throw new InvalidOperationException("初始化未完成。请检查这一步：\n" + error);
        }
    }

    private static void InvokeTask(string action)
    {
        var start = new ProcessStartInfo
        {
            FileName = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"),
            Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + Path.Combine(Root, "scripts", "windows", "backend-task.ps1") + "\" " + action,
            WorkingDirectory = Root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true
        };
        using (var process = Process.Start(start))
        {
            string error = process.StandardError.ReadToEnd();
            process.WaitForExit();
            if (process.ExitCode != 0) throw new InvalidOperationException(error.Trim());
        }
    }

    private static string ReadStatus()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(Address + "/api/health");
            request.Proxy = null;
            request.Timeout = 1200;
            request.AllowAutoRedirect = false;
            using (var response = (HttpWebResponse)request.GetResponse())
                return response.Headers["X-AI-WebChat"] == "1" ? "正在运行 · 127.0.0.1:3000" : "端口被其他程序使用";
        }
        catch (WebException error)
        {
            if (error.Response == null) return "后端未响应";
            using (var response = (HttpWebResponse)error.Response)
                return response.Headers["X-AI-WebChat"] == "1" ? "数据库暂不可用" : "端口 3000 未返回 AI WebChat 状态";
        }
    }
}
