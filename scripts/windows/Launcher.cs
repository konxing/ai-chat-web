using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
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
            AddAction("启动", () => Run("Start"));
            AddAction("停止", () => Run("Stop"));
            AddAction("开启登录自启", () => Run("Enable"));
            AddAction("关闭登录自启", () => Run("Disable"));
            AddAction("打开聊天", () => Open(Address));
            AddAction("查看日志", () => Open(Log));
            timer.Tick += async (sender, args) => await RefreshStatus();
            Shown += async (sender, args) => { timer.Start(); await RefreshStatus(); };
            FormClosed += (sender, args) => timer.Dispose();
        }

        private void AddAction(string title, Action click)
        {
            var button = new Button { Text = title, AutoSize = true, Height = 33 };
            button.Click += (sender, args) => click();
            actions.Controls.Add(button);
        }

        private async void Run(string action)
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
