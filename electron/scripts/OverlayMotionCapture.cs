using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

internal static class OverlayMotionCapture
{
    private const int SrcCopy = 0x00CC0020;
    private const int CaptureBlt = 0x40000000;

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr window);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr window, IntPtr dc);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleDC(IntPtr dc);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int width, int height);

    [DllImport("gdi32.dll")]
    private static extern IntPtr SelectObject(IntPtr dc, IntPtr value);

    [DllImport("gdi32.dll")]
    private static extern bool BitBlt(
        IntPtr destination,
        int destinationX,
        int destinationY,
        int width,
        int height,
        IntPtr source,
        int sourceX,
        int sourceY,
        int operation);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr value);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteDC(IntPtr dc);

    private static int Main(string[] args)
    {
        if (args.Length != 7)
        {
            Console.Error.WriteLine("Usage: capture x y width height durationMs intervalMs outputDir");
            return 2;
        }
        int x = int.Parse(args[0], CultureInfo.InvariantCulture);
        int y = int.Parse(args[1], CultureInfo.InvariantCulture);
        int width = int.Parse(args[2], CultureInfo.InvariantCulture);
        int height = int.Parse(args[3], CultureInfo.InvariantCulture);
        int durationMs = int.Parse(args[4], CultureInfo.InvariantCulture);
        int intervalMs = int.Parse(args[5], CultureInfo.InvariantCulture);
        string outputDir = Path.GetFullPath(args[6]);
        Directory.CreateDirectory(outputDir);
        SetProcessDpiAwarenessContext(new IntPtr(-4));

        IntPtr screenDc = GetDC(IntPtr.Zero);
        IntPtr memoryDc = CreateCompatibleDC(screenDc);
        IntPtr bitmap = CreateCompatibleBitmap(screenDc, width, height);
        IntPtr previous = SelectObject(memoryDc, bitmap);
        var timestamps = new List<string>();
        var stopwatch = Stopwatch.StartNew();
        long nextFrame = 0;
        int frame = 0;
        Console.WriteLine("READY");
        Console.Out.Flush();
        try
        {
            while (stopwatch.ElapsedMilliseconds <= durationMs)
            {
                BitBlt(memoryDc, 0, 0, width, height, screenDc, x, y, SrcCopy | CaptureBlt);
                using (var image = Image.FromHbitmap(bitmap))
                {
                    image.Save(
                        Path.Combine(outputDir, frame.ToString("D3", CultureInfo.InvariantCulture) + ".png"),
                        ImageFormat.Png);
                }
                timestamps.Add(frame.ToString(CultureInfo.InvariantCulture) + ","
                    + stopwatch.Elapsed.TotalMilliseconds.ToString("F3", CultureInfo.InvariantCulture));
                frame += 1;
                nextFrame += intervalMs;
                int wait = (int)Math.Max(0, nextFrame - stopwatch.ElapsedMilliseconds);
                if (wait > 0) Thread.Sleep(wait);
            }
            File.WriteAllLines(Path.Combine(outputDir, "timestamps.csv"), timestamps);
            Console.WriteLine("DONE " + frame.ToString(CultureInfo.InvariantCulture));
            return 0;
        }
        finally
        {
            SelectObject(memoryDc, previous);
            DeleteObject(bitmap);
            DeleteDC(memoryDc);
            ReleaseDC(IntPtr.Zero, screenDc);
        }
    }
}
