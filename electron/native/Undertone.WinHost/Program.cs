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
    private const int ProtocolVersion = 9;
    private const int FocusReadAttempts = 3;
    private const int FocusReadTimeoutMs = 150;
    private const int FocusRetryDelayMs = 50;
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

    public static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--extract-subset")
            return ExtractSubset();
        if (args.Length != 0)
            return 2;
        return RunResidentHost();
    }

    private static int ExtractSubset()
    {
        try
        {
            var line = Console.In.ReadLine();
            if (string.IsNullOrEmpty(line))
                throw new InvalidOperationException("Extraction payload is missing");
            var payload = Json.Deserialize<Dictionary<string, object>>(line);
            if (BoundedInt(payload, "protocol", 0, 0, int.MaxValue) != ProtocolVersion)
                throw new InvalidOperationException("Extraction protocol is unsupported");
            var cancellation = new ExtractionCancellation();
            var parentMonitor = new Thread(new ThreadStart(delegate
            {
                try { Console.In.ReadLine(); }
                finally { cancellation.IsCancelled = true; }
            })) { IsBackground = true, Name = "extraction-parent" };
            parentMonitor.Start();
            var count = ArchiveInstaller.ExtractSubset(
                StringList(payload, "zipFiles"),
                StringList(payload, "patterns"),
                StringValue(payload, "targetDirectory"),
                delegate { return cancellation.IsCancelled; });
            Console.Out.WriteLine(Json.Serialize(new Dictionary<string, object>
            {
                { "protocol", ProtocolVersion },
                { "fileCount", count }
            }));
            return 0;
        }
        catch (Exception error)
        {
            Console.Out.WriteLine(Json.Serialize(new Dictionary<string, object>
            {
                { "protocol", ProtocolVersion },
                { "message", error.Message }
            }));
            return 1;
        }
    }

    private static int RunResidentHost()
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
            object rawProtocol;
            if (!command.TryGetValue("protocol", out rawProtocol)
                || !(rawProtocol is int)
                || (int)rawProtocol != ProtocolVersion)
                throw new InvalidOperationException("Protocol is unsupported");

            if (type == "setInputMode")
            {
                var mode = RequiredString(command, "mode");
                SetInputMode(mode);
                Respond(requestId, "inputModeSet", new Dictionary<string, object>
                {
                    { "mode", mode }
                });
            }
            else if (type == "getForeground")
            {
                string generation;
                var foreground = CaptureForeground(out generation);
                Respond(requestId, "foreground", new Dictionary<string, object>
                {
                    { "window", foreground.Window },
                    { "focus", foreground.Focus },
                    { "focusIdentityState", FocusIdentityStateName(foreground.FocusIdentity.State) },
                    { "focusIdentity", foreground.FocusIdentity.Value },
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
                var expected = GuardedPasteTarget(command);
                string focusGeneration;
                var foreground = CaptureForeground(out focusGeneration);
                string reason;
                string status;
                lock (InputGate)
                {
                    var currentHandles = Desktop.GetForeground(foreground.FocusIdentity);
                    if (expected.Generation != focusGeneration
                        || focusGeneration != Interlocked.Read(ref _inputGeneration).ToString())
                        reason = "input-race";
                    else if (foreground.Window != currentHandles.Window
                        || foreground.Focus != currentHandles.Focus)
                        reason = HandlesChangedReason(expected, currentHandles);
                    else
                        reason = FocusMismatchReason(expected, foreground);
                    if (reason == null)
                    {
                        status = Desktop.SendPaste() ? "pasted" : "paste-failed";
                        reason = status == "pasted" ? "none" : "send-input";
                    }
                    else
                    {
                        status = IsConfirmedFocusChange(reason)
                            ? "focus-changed"
                            : "focus-unavailable";
                    }
                }
                Respond(requestId, "guardedPasteResult", new Dictionary<string, object>
                {
                    { "status", status },
                    { "reason", reason }
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
                    StringValue(command, "logFile"));
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
                Respond(requestId, "processRunning", new Dictionary<string, object>
                {
                    { "running", _supervisor.IsRunning(processId) }
                });
            }
            else if (type == "getCudaStatus")
            {
                var status = CudaProbe.Detect();
                Respond(requestId, "cudaStatus", new Dictionary<string, object>
                {
                    { "driverPresent", status.DriverPresent },
                    { "compatible", status.Compatible },
                    { "driverApiVersion", status.DriverApiVersion },
                    { "deviceCount", status.DeviceCount }
                });
            }
            else if (type == "shutdown")
            {
                SetInputMode("off");
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
        ForegroundInfo unavailable = null;
        var unavailableSamples = 0;
        for (var attempt = 0; attempt < FocusReadAttempts; attempt += 1)
        {
            var before = Interlocked.Read(ref _inputGeneration);
            var handlesBefore = Desktop.GetForeground(FocusIdentityResult.Degraded());
            var focusIdentity = _focusReader.QueryIdentity(FocusReadTimeoutMs);
            var foreground = Desktop.GetForeground(focusIdentity);
            var after = Interlocked.Read(ref _inputGeneration);
            var stable = before == after
                && handlesBefore.Window == foreground.Window
                && handlesBefore.Focus == foreground.Focus;
            if (stable && focusIdentity.State == FocusIdentityState.Available)
            {
                generation = after.ToString();
                return foreground;
            }
            if (stable && focusIdentity.State == FocusIdentityState.Unavailable)
            {
                unavailableSamples = unavailable != null
                    && unavailable.Window == foreground.Window
                    && unavailable.Focus == foreground.Focus
                    ? unavailableSamples + 1
                    : 1;
                unavailable = foreground;
                if (unavailableSamples >= 2)
                {
                    generation = after.ToString();
                    return foreground;
                }
            }
            else
            {
                unavailable = null;
                unavailableSamples = 0;
            }
            if (attempt + 1 < FocusReadAttempts)
                Thread.Sleep(FocusRetryDelayMs);
        }
        generation = Interlocked.Read(ref _inputGeneration).ToString();
        return Desktop.GetForeground(FocusIdentityResult.Degraded());
    }

    private static void SetInputMode(string mode)
    {
        if (mode == "off")
        {
            _captureInput = false;
            _suppressKeyboard = false;
        }
        else if (mode == "listen")
        {
            _captureInput = true;
            _suppressKeyboard = false;
        }
        else if (mode == "shortcut-capture")
        {
            _captureInput = true;
            _suppressKeyboard = true;
        }
        else
        {
            throw new InvalidOperationException("Input mode is invalid");
        }
    }

    private static GuardedTarget GuardedPasteTarget(Dictionary<string, object> values)
    {
        var state = RequiredString(values, "focusIdentityState");
        object rawIdentity;
        if (!values.TryGetValue("focusIdentity", out rawIdentity))
            throw new InvalidOperationException("focusIdentity is required");

        string identity = null;
        if (state == "available")
        {
            identity = rawIdentity as string;
            if (string.IsNullOrEmpty(identity))
                throw new InvalidOperationException("Available focus identity is invalid");
        }
        else if (state == "unavailable")
        {
            if (rawIdentity != null)
                throw new InvalidOperationException("Unavailable focus identity must be null");
        }
        else
        {
            throw new InvalidOperationException("Focus identity state is invalid");
        }

        return new GuardedTarget
        {
            Window = RequiredString(values, "window"),
            Focus = RequiredString(values, "focus"),
            FocusIdentityState = state,
            FocusIdentity = identity,
            Generation = RequiredString(values, "generation")
        };
    }

    private static string HandlesChangedReason(
        GuardedTarget expected,
        ForegroundInfo actual)
    {
        if (expected.Window == "0" || actual.Window == "0")
            return "window-unavailable";
        if (expected.Window != actual.Window)
            return "window-changed";
        if (expected.Focus == "0" || actual.Focus == "0")
            return "focus-unavailable";
        return expected.Focus != actual.Focus ? "control-changed" : "snapshot-unstable";
    }

    private static string FocusMismatchReason(
        GuardedTarget expected,
        ForegroundInfo actual)
    {
        if (expected.Window == "0" || actual.Window == "0")
            return "window-unavailable";
        if (expected.Window != actual.Window)
            return "window-changed";
        if (expected.Focus == "0" || actual.Focus == "0")
            return "focus-unavailable";
        if (expected.Focus != actual.Focus)
            return "control-changed";
        if (actual.FocusIdentity.State == FocusIdentityState.Degraded)
            return "identity-unavailable";
        if (expected.FocusIdentityState == "available")
            return actual.FocusIdentity.State == FocusIdentityState.Available
                ? expected.FocusIdentity == actual.FocusIdentity.Value ? null : "identity-changed"
                : "identity-unavailable";
        return actual.FocusIdentity.State == FocusIdentityState.Unavailable
            ? null
            : "identity-unavailable";
    }

    private static bool IsConfirmedFocusChange(string reason)
    {
        return reason == "window-changed"
            || reason == "control-changed"
            || reason == "identity-changed";
    }

    private static string FocusIdentityStateName(FocusIdentityState state)
    {
        if (state == FocusIdentityState.Available) return "available";
        if (state == FocusIdentityState.Unavailable) return "unavailable";
        return "degraded";
    }

    private static string RequiredString(Dictionary<string, object> values, string key)
    {
        object value;
        var text = values.TryGetValue(key, out value) ? value as string : null;
        if (string.IsNullOrEmpty(text))
            throw new InvalidOperationException(key + " is required");
        return text;
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
                    { "virtualKey", data.VirtualKey },
                    { "injected", (data.Flags & LlkhfInjected) != 0 }
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
            if (message == WmLButtonDown
                || message == WmRButtonDown
                || message == WmMButtonDown
                || message == WmXButtonDown)
            {
                lock (InputGate)
                    Interlocked.Increment(ref _inputGeneration);
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

    private sealed class GuardedTarget
    {
        public string Window;
        public string Focus;
        public string FocusIdentityState;
        public string FocusIdentity;
        public string Generation;
    }

    private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

    private sealed class ExtractionCancellation
    {
        public volatile bool IsCancelled;
    }

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
