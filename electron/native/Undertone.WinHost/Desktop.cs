using System;
using System.Runtime.InteropServices;

internal sealed class ForegroundInfo
{
    public string Window;
    public string Focus;
    public FocusIdentityResult FocusIdentity;
}

internal static class Desktop
{
    public static readonly UIntPtr OwnInputMarker = new UIntPtr(0x554E4452);
    private const uint InputKeyboard = 1;
    private const ushort VkControl = 0x11;
    private const ushort VkV = 0x56;
    private const uint KeyEventKeyUp = 0x0002;
    private const uint KeyEventUnicode = 0x0004;

    public static ForegroundInfo GetForeground(FocusIdentityResult focusIdentity)
    {
        var window = GetForegroundWindow();
        var focus = GetFocusedWindow(window);
        return new ForegroundInfo
        {
            Window = window.ToInt64().ToString(),
            Focus = focus.ToInt64().ToString(),
            FocusIdentity = focusIdentity
        };
    }

    private static IntPtr GetFocusedWindow(IntPtr foreground)
    {
        if (foreground == IntPtr.Zero)
            return IntPtr.Zero;
        uint ignored;
        var threadId = GetWindowThreadProcessId(foreground, out ignored);
        var info = new GuiThreadInfo { Size = Marshal.SizeOf(typeof(GuiThreadInfo)) };
        return threadId != 0 && GetGUIThreadInfo(threadId, ref info)
            ? info.Focus
            : IntPtr.Zero;
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

    public static bool SendText(string text)
    {
        if (text.Length == 0)
            return true;
        var inputs = new Input[text.Length * 2];
        for (var index = 0; index < text.Length; index++)
        {
            inputs[index * 2] = UnicodeKey(text[index], KeyEventUnicode);
            inputs[index * 2 + 1] = UnicodeKey(text[index], KeyEventUnicode | KeyEventKeyUp);
        }
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
                    ExtraInfo = OwnInputMarker
                }
            }
        };
    }

    private static Input UnicodeKey(char character, uint flags)
    {
        return new Input
        {
            Type = InputKeyboard,
            Data = new InputUnion
            {
                Keyboard = new KeyboardInput
                {
                    VirtualKey = 0,
                    ScanCode = character,
                    Flags = flags,
                    Time = 0,
                    ExtraInfo = OwnInputMarker
                }
            }
        };
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct GuiThreadInfo
    {
        public int Size;
        public uint Flags;
        public IntPtr Active;
        public IntPtr Focus;
        public IntPtr Capture;
        public IntPtr MenuOwner;
        public IntPtr MoveSize;
        public IntPtr Caret;
        public Rect CaretRect;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
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
    private static extern bool GetGUIThreadInfo(uint threadId, ref GuiThreadInfo info);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, Input[] inputs, int size);

}
