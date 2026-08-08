using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

internal static class Program
{
    private const int ProtocolVersion = 6;
    private const int WhKeyboardLl = 13;
    private const int WhMouseLl = 14;
    private const int WmKeyDown = 0x0100;
    private const int WmKeyUp = 0x0101;
    private const int WmSysKeyDown = 0x0104;
    private const int WmSysKeyUp = 0x0105;
    private const int WmLButtonDown = 0x0201;
    private const int WmRButtonDown = 0x0204;
    private const int WmMButtonDown = 0x0207;
    private const int WmXButtonDown = 0x020B;
    private const uint WmQuit = 0x0012;
    private const uint LlkhfExtended = 0x01;
    private const uint LlkhfInjected = 0x10;

    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly BlockingCollection<string> Output =
        new BlockingCollection<string>(new ConcurrentQueue<string>());
    private static readonly HookProc KeyboardProc = OnKeyboard;
    private static readonly HookProc MouseProc = OnMouse;
    private static readonly object InputGate = new object();

    private static volatile bool _captureInput;
    private static volatile bool _suppressKeyboard;
    private static uint _mainThreadId;
    private static IntPtr _keyboardHook;
    private static IntPtr _mouseHook;
    private static FocusReader _focusReader;
    private static ProcessSupervisor _supervisor;
    private static long _inputGeneration;

    public static int Main()
    {
        _mainThreadId = GetCurrentThreadId();
        var writer = new Thread(WriteOutput) { IsBackground = true, Name = "stdout" };
        writer.Start();

        try
        {
            _focusReader = new FocusReader();
            _supervisor = new ProcessSupervisor();
            _keyboardHook = InstallHook(WhKeyboardLl, KeyboardProc);
            _mouseHook = InstallHook(WhMouseLl, MouseProc);

            var reader = new Thread(ReadCommands) { IsBackground = true, Name = "stdin" };
            reader.Start();

            Emit(new Dictionary<string, object>
            {
                { "protocol", ProtocolVersion },
                { "type", "ready" },
                { "keyboardHook", _keyboardHook != IntPtr.Zero },
                { "mouseHook", _mouseHook != IntPtr.Zero }
            });

            Message message;
            while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref message);
                DispatchMessage(ref message);
            }
            return 0;
        }
        catch (Exception error)
        {
            EmitError("host_failure", error.Message);
            return 1;
        }
        finally
        {
            if (_keyboardHook != IntPtr.Zero)
                UnhookWindowsHookEx(_keyboardHook);
            if (_mouseHook != IntPtr.Zero)
                UnhookWindowsHookEx(_mouseHook);
            if (_supervisor != null)
                _supervisor.Dispose();
            if (_focusReader != null)
                _focusReader.Dispose();
            Output.CompleteAdding();
            writer.Join(1000);
        }
    }

    private static IntPtr InstallHook(int hookId, HookProc callback)
    {
        using (var process = Process.GetCurrentProcess())
        using (var module = process.MainModule)
        {
            var moduleHandle = module == null
                ? IntPtr.Zero
                : GetModuleHandle(module.ModuleName);
            return SetWindowsHookEx(hookId, callback, moduleHandle, 0);
        }
    }

    private static void ReadCommands()
    {
        string line;
        try
        {
            while ((line = Console.In.ReadLine()) != null)
            {
                Dictionary<string, object> command;
                try
                {
                    command = Json.Deserialize<Dictionary<string, object>>(line);
                }
                catch (Exception error)
                {
                    EmitError("invalid_json", error.Message);
                    continue;
                }
                HandleCommand(command);
            }
        }
        finally
        {
            PostThreadMessage(_mainThreadId, WmQuit, IntPtr.Zero, IntPtr.Zero);
        }
    }

    private static void HandleCommand(Dictionary<string, object> command)
    {
        object rawType;
        var type = command.TryGetValue("type", out rawType) ? rawType as string : null;
        object requestId;
        command.TryGetValue("requestId", out requestId);

        try
        {
            if (type == "startInput")
            {
                _captureInput = true;
                Respond(requestId, "inputStarted");
            }
            else if (type == "stopInput")
            {
                _captureInput = false;
                _suppressKeyboard = false;
                Respond(requestId, "inputStopped");
            }
            else if (type == "startShortcutCapture")
            {
                _captureInput = true;
                _suppressKeyboard = true;
                Respond(requestId, "shortcutCaptureStarted");
            }
            else if (type == "stopShortcutCapture")
            {
                _suppressKeyboard = false;
                Respond(requestId, "shortcutCaptureStopped");
            }
            else if (type == "getForeground")
            {
                string generation;
                var foreground = CaptureForeground(out generation);
                Respond(requestId, "foreground", new Dictionary<string, object>
                {
                    { "window", foreground.Window },
                    { "focus", foreground.Focus },
                    { "focusIdentity", foreground.FocusIdentity },
                    { "generation", generation }
                });
            }
            else if (type == "sendPaste")
            {
                Respond(requestId, "pasteResult", new Dictionary<string, object>
                {
                    { "sent", Desktop.SendPaste() }
                });
            }
            else if (type == "guardedPaste")
            {
                bool focusMatched;
                bool sent = false;
                lock (InputGate)
                {
                    var focusIdentity = _focusReader.QueryIdentity(150);
                    var foreground = Desktop.GetForeground(focusIdentity);
                    focusMatched = FocusMatches(command, foreground)
                        && StringValue(command, "generation")
                            == Interlocked.Read(ref _inputGeneration).ToString();
                    if (focusMatched)
                        sent = Desktop.SendPaste();
                }
                Respond(requestId, "guardedPasteResult", new Dictionary<string, object>
                {
                    { "focusMatched", focusMatched },
                    { "sent", sent }
                });
            }
            else if (type == "protectSecret")
            {
                Respond(requestId, "secretProtected", new Dictionary<string, object>
                {
                    { "value", SecretProtector.Protect(StringValue(command, "value")) }
                });
            }
            else if (type == "unprotectSecret")
            {
                Respond(requestId, "secretUnprotected", new Dictionary<string, object>
                {
                    { "value", SecretProtector.Unprotect(StringValue(command, "value")) }
                });
            }
            else if (type == "spawnSupervised")
            {
                var processId = _supervisor.Start(
                    StringValue(command, "file"),
                    StringValue(command, "arguments"),
                    StringValue(command, "workingDirectory"),
                    StringValue(command, "logFile"),
                    StringMap(command, "environment"));
                Respond(requestId, "processStarted", new Dictionary<string, object>
                {
                    { "processId", processId }
                });
            }
            else if (type == "stopSupervised")
            {
                var processId = BoundedInt(command, "processId", 0, 1, int.MaxValue);
                Respond(requestId, "processStopped", new Dictionary<string, object>
                {
                    { "stopped", _supervisor.Stop(processId) }
                });
            }
            else if (type == "isSupervisedRunning")
            {
                var processId = BoundedInt(command, "processId", 0, 1, int.MaxValue);
                int exitCode;
                var hasExitCode = _supervisor.TryGetExitCode(processId, out exitCode);
                Respond(requestId, "processStatus", new Dictionary<string, object>
                {
                    { "running", _supervisor.IsRunning(processId) },
                    { "exitCode", hasExitCode ? (object)exitCode : null }
                });
            }
            else if (type == "extractSubset")
            {
                var count = ArchiveInstaller.ExtractSubset(
                    StringList(command, "zipFiles"),
                    StringList(command, "patterns"),
                    StringValue(command, "targetDirectory"));
                Respond(requestId, "subsetExtracted", new Dictionary<string, object>
                {
                    { "fileCount", count }
                });
            }
            else if (type == "shutdown")
            {
                _captureInput = false;
                _suppressKeyboard = false;
                Respond(requestId, "shuttingDown");
                PostThreadMessage(_mainThreadId, WmQuit, IntPtr.Zero, IntPtr.Zero);
            }
            else
            {
                EmitError("unknown_command", type ?? "Missing command type", requestId);
            }
        }
        catch (Exception error)
        {
            EmitError("command_failed", error.Message, requestId);
        }
    }

    private static void Respond(
        object requestId,
        string type,
        Dictionary<string, object> values = null)
    {
        var response = new Dictionary<string, object>
        {
            { "protocol", ProtocolVersion },
            { "type", type },
            { "requestId", requestId }
        };
        if (values != null)
        {
            foreach (var pair in values)
                response[pair.Key] = pair.Value;
        }
        Emit(response);
    }

    private static ForegroundInfo CaptureForeground(out string generation)
    {
        ForegroundInfo foreground = null;
        for (var attempt = 0; attempt < 2; attempt += 1)
        {
            var before = Interlocked.Read(ref _inputGeneration);
            var focusIdentity = _focusReader.QueryIdentity(150);
            foreground = Desktop.GetForeground(focusIdentity);
            var after = Interlocked.Read(ref _inputGeneration);
            if (before == after)
            {
                generation = after.ToString();
                return foreground;
            }
        }
        generation = Interlocked.Read(ref _inputGeneration).ToString();
        return Desktop.GetForeground(null);
    }

    private static bool FocusMatches(
        Dictionary<string, object> expected,
        ForegroundInfo actual)
    {
        if (StringValue(expected, "window") != actual.Window)
            return false;
        var focus = StringValue(expected, "focus");
        if (focus.Length > 0 && focus != "0" && focus != actual.Focus)
            return false;
        var identity = StringValue(expected, "focusIdentity");
        return identity.Length > 0
            ? identity == actual.FocusIdentity
            : string.IsNullOrEmpty(actual.FocusIdentity);
    }

    private static string StringValue(Dictionary<string, object> values, string key)
    {
        object value;
        return values.TryGetValue(key, out value) && value != null
            ? Convert.ToString(value)
            : string.Empty;
    }

    private static int BoundedInt(
        Dictionary<string, object> values,
        string key,
        int fallback,
        int minimum,
        int maximum)
    {
        object value;
        int parsed;
        if (!values.TryGetValue(key, out value)
            || value == null
            || !int.TryParse(Convert.ToString(value), out parsed))
            return fallback;
        return Math.Max(minimum, Math.Min(maximum, parsed));
    }

    private static List<string> StringList(
        Dictionary<string, object> values,
        string key)
    {
        object value;
        var result = new List<string>();
        if (!values.TryGetValue(key, out value) || value == null || value is string)
            return result;
        var items = value as IEnumerable;
        if (items == null)
            return result;
        foreach (var item in items)
        {
            if (item != null)
                result.Add(Convert.ToString(item));
        }
        return result;
    }

    private static Dictionary<string, string> StringMap(
        Dictionary<string, object> values,
        string key)
    {
        object value;
        var result = new Dictionary<string, string>();
        if (!values.TryGetValue(key, out value) || value == null)
            return result;
        var dictionary = value as Dictionary<string, object>;
        if (dictionary == null)
            return result;
        foreach (var pair in dictionary)
        {
            result[pair.Key] = pair.Value == null ? null : Convert.ToString(pair.Value);
        }
        return result;
    }

    private static IntPtr OnKeyboard(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0 && _captureInput)
        {
            var message = wParam.ToInt32();
            var eventType = message == WmKeyDown || message == WmSysKeyDown
                ? "down"
                : message == WmKeyUp || message == WmSysKeyUp ? "up" : null;
            if (eventType != null)
            {
                var data = (KeyboardData)Marshal.PtrToStructure(
                    lParam, typeof(KeyboardData));
                if (eventType == "down" && (data.Flags & LlkhfInjected) == 0)
                {
                    lock (InputGate)
                        Interlocked.Increment(ref _inputGeneration);
                }
                Emit(new Dictionary<string, object>
                {
                    { "protocol", ProtocolVersion },
                    { "type", "keyboard" },
                    { "eventType", eventType },
                    { "scanCode", data.ScanCode },
                    { "virtualKey", data.VirtualKey },
                    { "injected", (data.Flags & LlkhfInjected) != 0 },
                    { "extended", (data.Flags & LlkhfExtended) != 0 }
                });
            }
        }
        return code >= 0 && _suppressKeyboard
            ? new IntPtr(1)
            : CallNextHookEx(_keyboardHook, code, wParam, lParam);
    }

    private static IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0 && _captureInput)
        {
            var message = wParam.ToInt32();
            string button = null;
            if (message == WmLButtonDown) button = "left";
            else if (message == WmRButtonDown) button = "right";
            else if (message == WmMButtonDown) button = "middle";
            else if (message == WmXButtonDown)
            {
                var data = (MouseData)Marshal.PtrToStructure(lParam, typeof(MouseData));
                button = ((data.MouseDataValue >> 16) & 0xffff) == 1 ? "x1" : "x2";
            }

            if (button != null)
            {
                lock (InputGate)
                    Interlocked.Increment(ref _inputGeneration);
                Emit(new Dictionary<string, object>
                {
                    { "protocol", ProtocolVersion },
                    { "type", "mouse" },
                    { "eventType", "down" },
                    { "button", button }
                });
            }
        }
        return CallNextHookEx(_mouseHook, code, wParam, lParam);
    }

    private static void EmitError(string code, string message, object requestId = null)
    {
        Emit(new Dictionary<string, object>
        {
            { "protocol", ProtocolVersion },
            { "type", "error" },
            { "code", code },
            { "message", message },
            { "requestId", requestId }
        });
    }

    private static void Emit(Dictionary<string, object> message)
    {
        if (!Output.IsAddingCompleted)
            Output.Add(Json.Serialize(message));
    }

    private static void WriteOutput()
    {
        using (var output = new StreamWriter(Console.OpenStandardOutput()))
        {
            output.AutoFlush = true;
            foreach (var line in Output.GetConsumingEnumerable())
                output.WriteLine(line);
        }
    }

    private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardData
    {
        public uint VirtualKey;
        public uint ScanCode;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseData
    {
        public Point Location;
        public uint MouseDataValue;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Message
    {
        public IntPtr Window;
        public uint Value;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public Point Location;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(
        int hookId, HookProc callback, IntPtr module, uint threadId);

    [DllImport("user32.dll")]
    private static extern bool UnhookWindowsHookEx(IntPtr hook);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(
        IntPtr hook, int code, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern int GetMessage(
        out Message message, IntPtr window, uint min, uint max);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref Message message);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref Message message);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostThreadMessage(
        uint threadId, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string moduleName);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
}
