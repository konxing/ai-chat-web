using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

internal static class Launcher
{
    private const string Address = "http://127.0.0.1:3000";

    [STAThread]
    private static int Main(string[] args)
    {
        bool checkOnly = args.Length == 1 && args[0] == "--check";
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string log = Path.Combine(root, "dist", "windows", "backend.log");
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(log));
            using (var mutex = new Mutex(false, @"Local\AIWebChat.Port3000"))
            {
                try
                {
                    if (!mutex.WaitOne(TimeSpan.FromMinutes(2))) throw new Exception("启动等待超时，请稍后重试。");
                }
                catch (AbandonedMutexException) { }
                try { EnsureBackend(root, log); }
                finally { mutex.ReleaseMutex(); }
            }
            if (!checkOnly) Process.Start(new ProcessStartInfo(Address) { UseShellExecute = true });
            return 0;
        }
        catch (Exception error)
        {
            try { File.AppendAllText(log, DateTime.Now + " " + error.Message + Environment.NewLine); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            if (!checkOnly) MessageBox.Show(error.Message + "\n\n日志位置\n" + log,
                "AI WebChat 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static void EnsureBackend(string root, string log)
    {
        if (IsReady()) return;
        if (!File.Exists(Path.Combine(root, ".env")))
            throw new Exception("找不到项目配置文件 .env。");
        if (!File.Exists(Path.Combine(root, ".next", "BUILD_ID")))
            throw new Exception("找不到网站构建文件。请重新打包启动器。");

        var start = new ProcessStartInfo("node.exe", "server.js")
        {
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        start.EnvironmentVariables["NODE_ENV"] = "production";
        start.EnvironmentVariables["HOST"] = "127.0.0.1";
        start.EnvironmentVariables["PORT"] = "3000";
        start.EnvironmentVariables["APP_URL"] = Address;
        start.EnvironmentVariables["TRUST_PROXY"] = "false";
        start.EnvironmentVariables["COOKIE_SECURE"] = "false";
        start.EnvironmentVariables["AI_WEBCHAT_LAUNCH_LOG"] = log;
        using (var backend = Process.Start(start))
        {
            var deadline = Stopwatch.StartNew();
            while (deadline.Elapsed < TimeSpan.FromSeconds(75))
            {
                if (backend.HasExited)
                    throw new Exception("后端提前退出。请检查端口 3000 是否被占用，并查看日志。");
                if (IsReady()) return;
                Thread.Sleep(500);
            }
            throw new Exception("本地服务未就绪。请检查 PostgreSQL 服务及数据库配置。");
        }
    }

    private static bool IsReady()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(Address + "/api/health");
            request.Proxy = null;
            request.Timeout = 1200;
            request.AllowAutoRedirect = false;
            using (var response = (HttpWebResponse)request.GetResponse())
                return response.StatusCode == HttpStatusCode.OK && response.Headers["X-AI-WebChat"] == "1";
        }
        catch (WebException error)
        {
            if (error.Response != null) error.Response.Dispose();
            return false;
        }
    }
}
