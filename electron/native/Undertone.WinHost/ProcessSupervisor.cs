using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

internal sealed class ProcessSupervisor : IDisposable
{
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;

    private readonly IntPtr _job;
    private readonly Dictionary<int, Process> _processes = new Dictionary<int, Process>();

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

    public int Start(string fileName, string arguments, string workingDirectory)
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
                CreateNoWindow = true
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
        lock (_processes)
        {
            _processes[process.Id] = process;
        }
        process.Exited += delegate
        {
            lock (_processes)
            {
                _processes.Remove(process.Id);
            }
            process.Dispose();
        };
        return process.Id;
    }

    public bool Stop(int processId)
    {
        Process process;
        lock (_processes)
        {
            if (!_processes.TryGetValue(processId, out process))
                return false;
        }
        try
        {
            if (!process.HasExited)
                process.Kill();
            return true;
        }
        catch
        {
            return false;
        }
    }

    public void Dispose()
    {
        if (_job != IntPtr.Zero)
            CloseHandle(_job);
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
