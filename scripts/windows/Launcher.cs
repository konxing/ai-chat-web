using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;
using System.Threading.Tasks;
using System.Windows.Forms;

internal static class Launcher
{
    private const string Address = "http://127.0.0.1:3000";
    private static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;
    private static readonly string Log = Path.Combine(Root, "dist", "windows", "backend.log");

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
            ClientSize = new Size(530, 170);
            MinimumSize = new Size(460, 200);
            StartPosition = FormStartPosition.CenterScreen;
            Padding = new Padding(18);
            var header = new Label { Text = "AI WebChat 后端", Dock = DockStyle.Top, Height = 34, Font = new Font(Font.FontFamily, 15) };
            var state = new Panel { Dock = DockStyle.Top, Height = 34 };
            state.Controls.Add(status);
            Controls.Add(actions);
            Controls.Add(state);
            Controls.Add(header);
            AddAction("启动", async () => await Run("Start"));
            AddAction("停止", async () => await Run("Stop"));
            AddAction("开启登录自启", async () => await Run("Enable"));
            AddAction("关闭登录自启", async () => await Run("Disable"));
            AddAction("打开聊天", () => Open(Address));
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
                            await Run("Start");
                            for (int attempt = 0; attempt < 30 && !IsDisposed; attempt++)
                            {
                                if ((await Task.Run((Func<string>)ReadStatus)).StartsWith("正在运行"))
                                {
                                    Open(Address);
                                    break;
                                }
                                await Task.Delay(500);
                            }
                        }
                    }
                }
                await RefreshStatus();
            };
            FormClosed += (sender, args) => timer.Dispose();
        }

        private void AddAction(string title, Action click)
        {
            var button = new Button { Text = title, AutoSize = true, Height = 33 };
            button.Click += (sender, args) => click();
            actions.Controls.Add(button);
        }

        private async Task Run(string action)
        {
            if (busy) return;
            busy = true;
            actions.Enabled = false;
            status.Text = "正在执行，请稍候…";
            string result = null;
            try
            {
                await Task.Run(() => InvokeTask(action));
                result = action == "Enable" ? "登录自启已开启" : action == "Disable" ? "登录自启已关闭" : null;
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
        private readonly TextBox database = new TextBox { UseSystemPasswordChar = true };
        private readonly TextBox username = new TextBox();
        private readonly TextBox email = new TextBox();
        private readonly TextBox password = new TextBox { UseSystemPasswordChar = true };
        private readonly Button install = new Button { Text = "初始化并启动", AutoSize = true };
        private bool running;

        public SetupDialog()
        {
            Text = "AI WebChat 首次运行";
            StartPosition = FormStartPosition.CenterParent;
            ClientSize = new Size(560, 305);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            var fields = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Padding = new Padding(18) };
            fields.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 124));
            fields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            var help = new Label {
                AutoSize = true,
                Text = "请先安装 Node.js 和项目依赖，并准备一个空 PostgreSQL 数据库。\n数据库地址格式：postgresql://用户:密码@127.0.0.1:5432/数据库\n管理员密码须符合网站的强度要求。"
            };
            fields.Controls.Add(help);
            fields.SetColumnSpan(help, 2);
            AddField(fields, "数据库连接地址", database);
            AddField(fields, "管理员用户名", username);
            AddField(fields, "管理员邮箱", email);
            AddField(fields, "管理员密码", password);
            fields.Controls.Add(install);
            Controls.Add(fields);
            AcceptButton = install;
            FormClosing += (sender, args) => { if (running) args.Cancel = true; };
            install.Click += async (sender, args) =>
            {
                if (running) return;
                running = true;
                fields.Enabled = false;
                install.Text = "正在初始化，请稍候…";
                try
                {
                    var input = new JavaScriptSerializer().Serialize(new {
                        database = database.Text.Trim(), username = username.Text.Trim(),
                        email = email.Text.Trim(), password = password.Text
                    });
                    await Task.Run(() => RunSetup(input));
                    password.Clear();
                    database.Clear();
                    running = false;
                    DialogResult = DialogResult.OK;
                }
                catch (Exception error)
                {
                    MessageBox.Show(this, error.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
                finally
                {
                    running = false;
                    fields.Enabled = true;
                    install.Text = "初始化并启动";
                }
            };
        }

        private static void AddField(TableLayoutPanel panel, string name, TextBox box)
        {
            panel.Controls.Add(new Label { Text = name, AutoSize = true, Anchor = AnchorStyles.Left });
            box.Dock = DockStyle.Top;
            panel.Controls.Add(box);
        }
    }

    private static void RunSetup(string input)
    {
        if (!File.Exists(Path.Combine(Root, "node_modules", "prisma", "build", "index.js")))
            throw new InvalidOperationException("缺少项目依赖，请先准备完整的 AI WebChat 项目目录。");
        var start = new ProcessStartInfo("node.exe", "scripts/windows/setup.cjs") {
            WorkingDirectory = Root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardError = true,
            StandardErrorEncoding = Encoding.UTF8
        };
        using (var process = Process.Start(start))
        {
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
            Arguments = "-NoProfile -NonInteractive -File \"" + Path.Combine(Root, "scripts", "windows", "backend-task.ps1") + "\" " + action,
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
