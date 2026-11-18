using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class BackendHost
{
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateNoWindow = 0x08000000;
    private const uint KillOnJobClose = 0x00002000;
    private const int ExtendedLimitInformation = 9;
    private const uint Infinite = 0xFFFFFFFF;
    private const uint UseStdHandles = 0x00000100;
    private const uint ReadAccess = 0x80000000;
    private const uint WriteAccess = 0x40000000;
    private const uint ShareReadWriteDelete = 7;
    private const uint OpenExisting = 3;
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);

    internal static int Run(string nodePath)
    {
        var root = AppDomain.CurrentDomain.BaseDirectory;
        var server = Path.Combine(root, "scripts", "windows", "backend.cjs");
        IntPtr job = IntPtr.Zero;
        IntPtr output = InvalidHandle, input = InvalidHandle;
        ProcessInformation child = new ProcessInformation();
        try
        {
            if (String.IsNullOrWhiteSpace(nodePath)) nodePath = FindNodeOnPath();
            if (String.IsNullOrWhiteSpace(nodePath) || !Path.IsPathRooted(nodePath) || !File.Exists(nodePath))
                throw new FileNotFoundException("Node.js executable was not found.");
            if (!File.Exists(server)) throw new FileNotFoundException("The backend script is missing.");

            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) ThrowLastError("Create backend job");
            var limits = new JobLimits();
            limits.Basic.LimitFlags = KillOnJobClose;
            if (!SetInformationJobObject(job, ExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(JobLimits))))
                ThrowLastError("Configure backend job");

            var handles = new SecurityAttributes
            {
                Size = Marshal.SizeOf(typeof(SecurityAttributes)),
                Inherit = 1
            };
            output = CreateFile("NUL", WriteAccess, ShareReadWriteDelete, ref handles, OpenExisting, 0, IntPtr.Zero);
            if (output == InvalidHandle) ThrowLastError("Open backend output");
            input = CreateFile("NUL", ReadAccess, ShareReadWriteDelete, ref handles, OpenExisting, 0, IntPtr.Zero);
            if (input == InvalidHandle) ThrowLastError("Open backend input");

            var startup = new StartupInformation
            {
                Size = Marshal.SizeOf(typeof(StartupInformation)),
                Flags = UseStdHandles,
                Input = input,
                Output = output,
                Error = output
            };
            var commandLine = new StringBuilder("\"" + nodePath + "\" \"" + server + "\"");
            if (!CreateProcess(nodePath, commandLine, IntPtr.Zero, IntPtr.Zero, true, CreateSuspended | CreateNoWindow,
                    IntPtr.Zero, root, ref startup, out child))
                ThrowLastError("Start Node.js");

            // A stopped launcher must never leave an independently running backend.
            if (!AssignProcessToJobObject(job, child.Process))
            {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(child.Process, 1);
                throw new Win32Exception(error, "Could not place Node.js in the backend job.");
            }
            if (ResumeThread(child.Thread) == UInt32.MaxValue) ThrowLastError("Resume Node.js");
            if (WaitForSingleObject(child.Process, Infinite) != 0) ThrowLastError("Wait for Node.js");

            uint exitCode;
            if (!GetExitCodeProcess(child.Process, out exitCode)) ThrowLastError("Read Node.js exit status");
            return unchecked((int)exitCode);
        }
        catch (Exception)
        {
            return 1;
        }
        finally
        {
            if (job != IntPtr.Zero) CloseHandle(job);
            if (output != InvalidHandle) CloseHandle(output);
            if (input != InvalidHandle) CloseHandle(input);
            if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
            if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
        }
    }

    private static string FindNodeOnPath()
    {
        foreach (string entry in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            var directory = entry.Trim().Trim('"');
            if (String.IsNullOrEmpty(directory) || !Path.IsPathRooted(directory)) continue;
            var candidate = Path.Combine(directory, "node.exe");
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    private static void ThrowLastError(string action)
    {
        int error = Marshal.GetLastWin32Error();
        throw new Win32Exception(error, action + ": " + new Win32Exception(error).Message);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInformation
    {
        public int Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
        public ushort ShowWindow, ReservedSize;
        public IntPtr ReservedData, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Size;
        public IntPtr Descriptor;
        public int Inherit;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicJobLimits
    {
        public long ProcessUserTime, JobUserTime;
        public uint LimitFlags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobLimits
    {
        public BasicJobLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref JobLimits limits, uint size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFile(string filename, uint access, uint share, ref SecurityAttributes attributes,
        uint creation, uint flags, IntPtr template);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string app, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
        ref StartupInformation startup, out ProcessInformation process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
