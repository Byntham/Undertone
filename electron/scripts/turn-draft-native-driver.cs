using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class TurnDraftNativeDriver
{
    private const uint MouseLeftDown = 0x0002;
    private const uint MouseLeftUp = 0x0004;
    private const uint RootAncestor = 2;
    private const uint NonClientHitTest = 0x0084;
    private const int HitClient = 1;
    private const int HitCaption = 2;
    private const string WindowTitle = "Undertone open turn native test";

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;

        public int Width { get { return Right - Left; } }
        public int Height { get { return Bottom - Top; } }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowRect(IntPtr window, out Rect rect);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern void mouse_event(
        uint flags,
        uint dx,
        uint dy,
        uint data,
        UIntPtr extraInfo);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(Point point);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr window, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    private static int Main(string[] args)
    {
        SetProcessDPIAware();
        int cycles = args.Length > 0 ? int.Parse(args[0]) : 50;
        IntPtr window = IntPtr.Zero;
        for (int waited = 0; waited <= 5000 && window == IntPtr.Zero; waited += 25)
        {
            window = FindWindow(null, WindowTitle);
            if (window == IntPtr.Zero) Thread.Sleep(25);
        }
        if (window == IntPtr.Zero)
        {
            Console.Error.WriteLine("FAIL window-not-found");
            return 1;
        }
        if (!WaitForVisibility(window, true, 5000))
        {
            Console.Error.WriteLine("FAIL window-not-visible");
            return 1;
        }

        for (int cycle = 1; cycle <= cycles; cycle++)
        {
            Rect before = Bounds(window);
            double scale = GetDpiForWindow(window) / 96.0;
            int headerX = before.Left + (int)Math.Round(200 * scale);
            int headerY = before.Top + (int)Math.Round(27 * scale);
            if (!RequireHit(window, headerX, headerY, cycle, "drag")) return 1;
            if (!RequireHitTest(window, headerX, headerY, HitCaption, cycle, "drag")) return 1;
            Drag(headerX, headerY, headerX + 30, headerY + 18);
            Thread.Sleep(100);
            Rect moved = Bounds(window);
            if (moved.Left == before.Left && moved.Top == before.Top)
            {
                return Fail(cycle, "drag", before, moved);
            }

            scale = GetDpiForWindow(window) / 96.0;
            int snapX = moved.Right - (int)Math.Round(52 * scale);
            int snapY = moved.Top + (int)Math.Round(27 * scale);
            if (!RequireHit(window, snapX, snapY, cycle, "snap")) return 1;
            if (!RequireHitTest(window, snapX, snapY, HitClient, cycle, "snap")) return 1;
            Click(snapX, snapY);
            Thread.Sleep(100);
            Rect snapped = Bounds(window);
            if (snapped.Left == moved.Left && snapped.Top == moved.Top)
            {
                return Fail(cycle, "snap", moved, snapped);
            }

            scale = GetDpiForWindow(window) / 96.0;
            int discardX = snapped.Right - (int)Math.Round(28 * scale);
            int discardY = snapped.Top + (int)Math.Round(27 * scale);
            if (!RequireHit(window, discardX, discardY, cycle, "discard")) return 1;
            Click(discardX, discardY);
            if (!WaitForVisibility(window, false, 200))
            {
                return Fail(cycle, "discard-hide", snapped, Bounds(window));
            }
            if (!WaitForVisibility(window, true, 1000))
            {
                return Fail(cycle, "discard-reshow", snapped, Bounds(window));
            }

            Rect resizeBefore = Bounds(window);
            int edgeX = resizeBefore.Right - 2;
            int edgeY = resizeBefore.Top + resizeBefore.Height / 2;
            Drag(edgeX, edgeY, edgeX + 24, edgeY);
            Thread.Sleep(100);
            Rect resized = Bounds(window);
            if (resized.Width <= resizeBefore.Width)
            {
                return Fail(cycle, "resize", resizeBefore, resized);
            }

            int restoreEdgeX = resized.Right - 2;
            int restoreEdgeY = resized.Top + resized.Height / 2;
            Drag(restoreEdgeX, restoreEdgeY, restoreEdgeX - 24, restoreEdgeY);
            Thread.Sleep(100);
            Rect restored = Bounds(window);
            if (restored.Width >= resized.Width)
            {
                return Fail(cycle, "resize-restore", resized, restored);
            }

            int bottomX = restored.Left + restored.Width / 2;
            int bottomY = restored.Bottom - 2;
            Drag(bottomX, bottomY, bottomX, bottomY + 24);
            Thread.Sleep(100);
            Rect taller = Bounds(window);
            if (taller.Height <= restored.Height)
            {
                return Fail(cycle, "resize-height", restored, taller);
            }

            int restoreBottomX = taller.Left + taller.Width / 2;
            int restoreBottomY = taller.Bottom - 2;
            Drag(restoreBottomX, restoreBottomY, restoreBottomX, restoreBottomY - 24);
            Thread.Sleep(100);
            Rect heightRestored = Bounds(window);
            if (heightRestored.Height >= taller.Height)
            {
                return Fail(cycle, "resize-height-restore", taller, heightRestored);
            }

            Console.WriteLine(
                "PASS cycle={0} bounds={1},{2},{3},{4}",
                cycle,
                heightRestored.Left,
                heightRestored.Top,
                heightRestored.Width,
                heightRestored.Height);
            Thread.Sleep(350);
        }

        Console.WriteLine("PASS native-turn-draft cycles={0}", cycles);
        return 0;
    }

    private static Rect Bounds(IntPtr window)
    {
        Rect rect;
        if (!GetWindowRect(window, out rect))
        {
            throw new InvalidOperationException("GetWindowRect failed: " + Marshal.GetLastWin32Error());
        }
        return rect;
    }

    private static void Click(int x, int y)
    {
        SetCursorPos(x, y);
        Thread.Sleep(20);
        mouse_event(MouseLeftDown, 0, 0, 0, UIntPtr.Zero);
        Thread.Sleep(35);
        mouse_event(MouseLeftUp, 0, 0, 0, UIntPtr.Zero);
    }

    private static void Drag(int fromX, int fromY, int toX, int toY)
    {
        SetCursorPos(fromX, fromY);
        Thread.Sleep(20);
        mouse_event(MouseLeftDown, 0, 0, 0, UIntPtr.Zero);
        for (int step = 1; step <= 8; step++)
        {
            SetCursorPos(
                fromX + (toX - fromX) * step / 8,
                fromY + (toY - fromY) * step / 8);
            Thread.Sleep(12);
        }
        mouse_event(MouseLeftUp, 0, 0, 0, UIntPtr.Zero);
    }

    private static bool WaitForVisibility(IntPtr window, bool visible, int timeoutMs)
    {
        int waited = 0;
        while (waited <= timeoutMs)
        {
            if (IsWindowVisible(window) == visible) return true;
            Thread.Sleep(10);
            waited += 10;
        }
        return false;
    }

    private static bool RequireHit(IntPtr expected, int x, int y, int cycle, string action)
    {
        IntPtr hit = GetAncestor(WindowFromPoint(new Point { X = x, Y = y }), RootAncestor);
        if (hit == expected) return true;
        var title = new StringBuilder(256);
        GetWindowText(hit, title, title.Capacity);
        Console.Error.WriteLine(
            "FAIL cycle={0} action={1}-covered expected={2} hit={3} hitTitle={4}",
            cycle,
            action,
            expected,
            hit,
            title);
        return false;
    }

    private static bool RequireHitTest(
        IntPtr window,
        int x,
        int y,
        int expected,
        int cycle,
        string action)
    {
        int packedPoint = (y << 16) | (x & 0xffff);
        int actual = SendMessage(
            window,
            NonClientHitTest,
            IntPtr.Zero,
            new IntPtr(packedPoint)).ToInt32();
        if (actual == expected) return true;
        Console.Error.WriteLine(
            "FAIL cycle={0} action={1}-hit-test expected={2} actual={3}",
            cycle,
            action,
            expected,
            actual);
        return false;
    }

    private static int Fail(int cycle, string action, Rect before, Rect after)
    {
        Console.Error.WriteLine(
            "FAIL cycle={0} action={1} before={2},{3},{4},{5} after={6},{7},{8},{9}",
            cycle,
            action,
            before.Left,
            before.Top,
            before.Width,
            before.Height,
            after.Left,
            after.Top,
            after.Width,
            after.Height);
        return 1;
    }
}
