using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Automation.Text;

internal sealed class CaretContext
{
    public string Before;
    public string After;
}

internal sealed class CaretReader : IDisposable
{
    private const int WmGetText = 0x000D;
    private const int WmGetTextLength = 0x000E;
    private const int EmGetSel = 0x00B0;
    private const uint SmtoAbortIfHung = 0x0002;
    private static readonly char[] EmptyValueChars =
        { ' ', '\t', '\r', '\n', '\u200b', '\ufeff', '\ufffc' };

    private readonly object _lock = new object();
    private BlockingCollection<Job> _jobs;
    private Thread _worker;
    private long _busySince;

    public CaretContext Query(int beforeCount, int afterCount, int timeoutMs)
    {
        EnsureWorker();
        var job = new Job(beforeCount, afterCount);
        _jobs.Add(job);
        if (job.Done.Wait(timeoutMs))
            return job.Result ?? QueryWin32(beforeCount, afterCount);
        job.Cancelled = true;
        return QueryWin32(beforeCount, afterCount);
    }

    public void Dispose()
    {
        lock (_lock)
        {
            if (_jobs != null)
                _jobs.CompleteAdding();
        }
    }

    private void EnsureWorker()
    {
        lock (_lock)
        {
            var busySince = Interlocked.Read(ref _busySince);
            var wedged = busySince != 0
                && DateTime.UtcNow.Ticks - busySince > TimeSpan.FromSeconds(3).Ticks;
            if (_worker != null && _worker.IsAlive && !wedged)
                return;
            _jobs = new BlockingCollection<Job>(new ConcurrentQueue<Job>());
            var jobs = _jobs;
            _worker = new Thread(() => Work(jobs))
            {
                IsBackground = true,
                Name = "uia"
            };
            _worker.SetApartmentState(ApartmentState.STA);
            _worker.Start();
        }
    }

    private void Work(BlockingCollection<Job> jobs)
    {
        foreach (var job in jobs.GetConsumingEnumerable())
        {
            if (job.Cancelled)
                continue;
            Interlocked.Exchange(ref _busySince, DateTime.UtcNow.Ticks);
            try
            {
                job.Result = QueryUia(job.BeforeCount, job.AfterCount);
            }
            catch
            {
                job.Result = null;
            }
            finally
            {
                Interlocked.Exchange(ref _busySince, 0);
                job.Done.Set();
            }
        }
    }

    private static CaretContext QueryUia(int beforeCount, int afterCount)
    {
        var element = AutomationElement.FocusedElement;
        if (element == null)
            return null;
        try
        {
            if (element.Current.IsPassword)
                return null;
        }
        catch
        {
        }

        var directEmpty = DirectValueIsEmpty(element);
        TextPatternRange caret = null;
        object pattern;
        TextPatternRange left = null;
        TextPatternRange right = null;
        try
        {
            if (element.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
            {
                var selection = ((TextPattern)pattern).GetSelection();
                if (selection != null && selection.Length > 0)
                {
                    var selected = selection[0];
                    if (selected.CompareEndpoints(
                        TextPatternRangeEndpoint.Start,
                        selected,
                        TextPatternRangeEndpoint.End) != 0)
                    {
                        left = selected.Clone();
                        left.MoveEndpointByRange(
                            TextPatternRangeEndpoint.End,
                            left,
                            TextPatternRangeEndpoint.Start);
                        right = selected.Clone();
                        right.MoveEndpointByRange(
                            TextPatternRangeEndpoint.Start,
                            right,
                            TextPatternRangeEndpoint.End);
                    }
                    else if (caret == null)
                    {
                        caret = selected;
                    }
                }
            }
        }
        catch
        {
        }

        if (left == null)
        {
            if (caret == null)
                return directEmpty ? new CaretContext { Before = "", After = "" } : null;
            left = caret;
            right = caret;
        }

        var beforeRange = left.Clone();
        beforeRange.MoveEndpointByUnit(
            TextPatternRangeEndpoint.Start, TextUnit.Character, -beforeCount);
        var before = beforeRange.GetText(-1);
        if (before == null)
            return null;
        if (directEmpty && before.TrimEnd(' ', '\t', '\r', '\n').EndsWith("\ufffc"))
            return new CaretContext { Before = "", After = "" };

        string after = null;
        try
        {
            var afterRange = right.Clone();
            afterRange.MoveEndpointByUnit(
                TextPatternRangeEndpoint.End, TextUnit.Character, afterCount);
            after = afterRange.GetText(-1);
        }
        catch
        {
        }
        return new CaretContext { Before = before, After = after };
    }

    private static bool DirectValueIsEmpty(AutomationElement element)
    {
        object pattern;
        try
        {
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
            {
                var value = ((ValuePattern)pattern).Current.Value;
                if (value != null && value.Trim(EmptyValueChars).Length == 0)
                    return true;
            }
        }
        catch
        {
        }
        return false;
    }

    private static CaretContext QueryWin32(int beforeCount, int afterCount)
    {
        try
        {
            var info = new GuiThreadInfo { Size = Marshal.SizeOf(typeof(GuiThreadInfo)) };
            if (!GetGUIThreadInfo(0, ref info) || info.Focus == IntPtr.Zero)
                return null;
            var className = new StringBuilder(64);
            GetClassName(info.Focus, className, className.Capacity);
            if (className.ToString().IndexOf("edit", StringComparison.OrdinalIgnoreCase) < 0)
                return null;

            UIntPtr result;
            if (SendMessageTimeout(info.Focus, WmGetTextLength, UIntPtr.Zero,
                IntPtr.Zero, SmtoAbortIfHung, 100, out result) == IntPtr.Zero)
                return null;
            var length = (int)result.ToUInt64();
            if (length >= 0xffff)
                return null;
            if (SendMessageTimeout(info.Focus, EmGetSel, UIntPtr.Zero,
                IntPtr.Zero, SmtoAbortIfHung, 100, out result) == IntPtr.Zero)
                return null;
            var selection = result.ToUInt64();
            var start = Math.Min((int)(selection & 0xffff), length);
            var end = Math.Min((int)((selection >> 16) & 0xffff), length);
            if (start > end)
            {
                var swap = start;
                start = end;
                end = swap;
            }

            var text = new StringBuilder(length + 1);
            if (SendMessageTimeout(info.Focus, WmGetText, new UIntPtr((uint)(length + 1)),
                text, SmtoAbortIfHung, 100, out result) == IntPtr.Zero)
                return null;
            var value = text.ToString();
            return new CaretContext
            {
                Before = value.Substring(Math.Max(0, start - beforeCount),
                    Math.Min(beforeCount, start)),
                After = value.Substring(end, Math.Min(afterCount, length - end))
            };
        }
        catch
        {
            return null;
        }
    }

    private sealed class Job
    {
        public readonly int BeforeCount;
        public readonly int AfterCount;
        public readonly ManualResetEventSlim Done = new ManualResetEventSlim(false);
        public volatile bool Cancelled;
        public CaretContext Result;

        public Job(int beforeCount, int afterCount)
        {
            BeforeCount = beforeCount;
            AfterCount = afterCount;
        }
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
    private struct GuiThreadInfo
    {
        public int Size;
        public int Flags;
        public IntPtr Active;
        public IntPtr Focus;
        public IntPtr Capture;
        public IntPtr MenuOwner;
        public IntPtr MoveSize;
        public IntPtr Caret;
        public Rect CaretRect;
    }

    [DllImport("user32.dll")]
    private static extern bool GetGUIThreadInfo(uint threadId, ref GuiThreadInfo info);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder value, int maximum);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(
        IntPtr window, uint message, UIntPtr wParam, IntPtr lParam,
        uint flags, uint timeout, out UIntPtr result);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(
        IntPtr window, uint message, UIntPtr wParam, StringBuilder lParam,
        uint flags, uint timeout, out UIntPtr result);
}
