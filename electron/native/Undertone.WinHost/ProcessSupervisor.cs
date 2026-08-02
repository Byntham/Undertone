using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

internal sealed class ProcessSupervisor : IDisposable
{
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;

    private readonly IntPtr _job;
    private readonly Dictionary<int, SupervisedProcess> _processes =
        new Dictionary<int, SupervisedProcess>();

    public ProcessSupervisor()
    {
        _job = CreateJobObject(IntPtr.Zero, null);
        if (_job == IntPtr.Zero)
            throw new InvalidOperationException("Could not create the Undertone job object");

        var info = new JobExtendedLimitInformation();
        info.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        var size = Marshal.SizeOf(typeof(JobExtendedLimitInformation));
        var pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, pointer, false);
            if (!SetInformationJobObject(
                _job, JobObjectExtendedLimitInformation, pointer, (uint)size))
                throw new InvalidOperationException("Could not configure the Undertone job object");
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    public int Start(
        string fileName,
        string arguments,
        string workingDirectory,
        string logFile)
    {
        var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = fileName,
                Arguments = arguments ?? "",
                WorkingDirectory = string.IsNullOrEmpty(workingDirectory)
                    ? Environment.CurrentDirectory
                    : workingDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            },
            EnableRaisingEvents = true
        };
        if (!process.Start())
            throw new InvalidOperationException("Could not start supervised process");
        if (!AssignProcessToJobObject(_job, process.Handle))
        {
            try { process.Kill(); } catch { }
            process.Dispose();
            throw new InvalidOperationException("Could not assign process to the Undertone job");
        }
        SupervisedProcess supervised;
        try
        {
            supervised = new SupervisedProcess(process, logFile);
        }
        catch
        {
            try { process.Kill(); } catch { }
            process.Dispose();
            throw;
        }
        process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args)
        {
            supervised.Write(args.Data);
        };
        process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args)
        {
            supervised.Write(args.Data);
        };
        lock (_processes) { _processes[process.Id] = supervised; }
        process.Exited += delegate
        {
            lock (_processes) { _processes.Remove(process.Id); }
            supervised.Dispose();
        };
        try { process.BeginOutputReadLine(); } catch (InvalidOperationException) { }
        try { process.BeginErrorReadLine(); } catch (InvalidOperationException) { }
        try
        {
            if (process.HasExited)
            {
                lock (_processes) { _processes.Remove(process.Id); }
                supervised.Dispose();
            }
        }
        catch { }
        return process.Id;
    }

    public bool Stop(int processId)
    {
        SupervisedProcess supervised;
        lock (_processes)
        {
            if (!_processes.TryGetValue(processId, out supervised))
                return false;
        }
        try
        {
            if (!supervised.Process.HasExited)
                supervised.Process.Kill();
            return true;
        }
        catch
        {
            return false;
        }
    }

    public bool IsRunning(int processId)
    {
        SupervisedProcess supervised;
        lock (_processes)
        {
            if (!_processes.TryGetValue(processId, out supervised))
                return false;
        }
        try { return !supervised.Process.HasExited; }
        catch { return false; }
    }

    public void Dispose()
    {
        if (_job != IntPtr.Zero)
            CloseHandle(_job);
    }

    private sealed class SupervisedProcess : IDisposable
    {
        private readonly object _logLock = new object();
        private StreamWriter _log;
        private bool _disposed;

        public readonly Process Process;

        public SupervisedProcess(Process process, string logFile)
        {
            Process = process;
            if (!string.IsNullOrEmpty(logFile))
            {
                var directory = Path.GetDirectoryName(logFile);
                if (!string.IsNullOrEmpty(directory))
                    Directory.CreateDirectory(directory);
                _log = new StreamWriter(logFile, false) { AutoFlush = true };
            }
        }

        public void Write(string line)
        {
            if (line == null)
                return;
            lock (_logLock)
            {
                try
                {
                    if (_log != null)
                        _log.WriteLine(line);
                }
                catch { }
            }
        }

        public void Dispose()
        {
            lock (_logLock)
            {
                if (_disposed)
                    return;
                _disposed = true;
                if (_log != null)
                {
                    try { _log.Dispose(); } catch { }
                    _log = null;
                }
            }
            try { Process.Dispose(); } catch { }
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobExtendedLimitInformation
    {
        public JobBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job, uint informationClass, IntPtr information, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
}
