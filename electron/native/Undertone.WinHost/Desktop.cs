using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal sealed class ForegroundInfo
{
    public string Window;
    public uint ProcessId;
    public string Executable;
    public string Title;
}

internal static class Desktop
{
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint InputKeyboard = 1;
    private const ushort VkControl = 0x11;
    private const ushort VkV = 0x56;
    private const uint KeyEventKeyUp = 0x0002;
    private const int SwRestore = 9;

    public static ForegroundInfo GetForeground()
    {
        var window = GetForegroundWindow();
        uint processId = 0;
        if (window != IntPtr.Zero)
            GetWindowThreadProcessId(window, out processId);
        return new ForegroundInfo
        {
            Window = window.ToInt64().ToString(),
            ProcessId = processId,
            Executable = GetExecutable(processId),
            Title = GetTitle(window)
        };
    }

    public static bool FocusWindow(IntPtr target)
    {
        if (target == IntPtr.Zero || !IsWindow(target))
            return false;
        if (GetForegroundWindow() == target)
            return true;

        var foreground = GetForegroundWindow();
        uint ignored;
        var foregroundThread = foreground == IntPtr.Zero
            ? 0
            : GetWindowThreadProcessId(foreground, out ignored);
        var targetThread = GetWindowThreadProcessId(target, out ignored);
        var currentThread = GetCurrentThreadId();
        var attachedForeground = foregroundThread != 0
            && foregroundThread != currentThread
            && AttachThreadInput(currentThread, foregroundThread, true);
        var attachedTarget = targetThread != 0
            && targetThread != currentThread
            && targetThread != foregroundThread
            && AttachThreadInput(currentThread, targetThread, true);
        try
        {
            ShowWindow(target, SwRestore);
            for (var attempt = 0; attempt < 10; attempt += 1)
            {
                BringWindowToTop(target);
                SetForegroundWindow(target);
                if (GetForegroundWindow() == target)
                    return true;
                Thread.Sleep(20);
            }
        }
        finally
        {
            if (attachedTarget)
                AttachThreadInput(currentThread, targetThread, false);
            if (attachedForeground)
                AttachThreadInput(currentThread, foregroundThread, false);
        }
        return false;
    }

    public static bool SendPaste()
    {
        var inputs = new[]
        {
            Key(VkControl, 0),
            Key(VkV, 0),
            Key(VkV, KeyEventKeyUp),
            Key(VkControl, KeyEventKeyUp)
        };
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input)))
            == (uint)inputs.Length;
    }

    private static Input Key(ushort virtualKey, uint flags)
    {
        return new Input
        {
            Type = InputKeyboard,
            Data = new InputUnion
            {
                Keyboard = new KeyboardInput
                {
                    VirtualKey = virtualKey,
                    ScanCode = 0,
                    Flags = flags,
                    Time = 0,
                    ExtraInfo = UIntPtr.Zero
                }
            }
        };
    }

    private static string GetTitle(IntPtr window)
    {
        if (window == IntPtr.Zero)
            return null;
        var title = new StringBuilder(256);
        GetWindowText(window, title, title.Capacity);
        return title.Length == 0 ? null : title.ToString();
    }

    private static string GetExecutable(uint processId)
    {
        if (processId == 0)
            return null;
        var process = OpenProcess(ProcessQueryLimitedInformation, false, processId);
        if (process == IntPtr.Zero)
            return null;
        try
        {
            var path = new StringBuilder(1024);
            var size = path.Capacity;
            if (!QueryFullProcessImageName(process, 0, path, ref size))
                return null;
            return Path.GetFileName(path.ToString()).ToLowerInvariant();
        }
        finally
        {
            CloseHandle(process);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input
    {
        public uint Type;
        public InputUnion Data;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MouseInput Mouse;
        [FieldOffset(0)] public KeyboardInput Keyboard;
    }

    // INPUT's native union is sized by MOUSEINPUT (32 bytes on x64), even
    // when SendInput receives only keyboard members. Omitting this member
    // makes Marshal.SizeOf<Input>() too small and SendInput rejects the call.
    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int X;
        public int Y;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort VirtualKey;
        public ushort ScanCode;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int maximum);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, Input[] inputs, int size);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(
        IntPtr process, uint flags, StringBuilder path, ref int size);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
}
