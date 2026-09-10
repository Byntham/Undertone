using System;
using System.Runtime.InteropServices;

internal static class Desktop
{
    private const uint InputKeyboard = 1;
    private const ushort VkControl = 0x11;
    private const ushort VkV = 0x56;
    private const uint KeyEventKeyUp = 0x0002;

    public static string ForegroundWindow()
    {
        return GetForegroundWindow().ToInt64().ToString();
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

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, Input[] inputs, int size);

}
