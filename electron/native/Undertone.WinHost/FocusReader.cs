using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Automation;

// Reads only UI Automation's opaque runtime ID. It never reads control text.
internal enum FocusIdentityState
{
    Available,
    Unavailable,
    Degraded
}

internal sealed class FocusIdentityResult
{
    public FocusIdentityState State;
    public string Value;
    public string RuntimeId;
    public string Fingerprint;
    public HashSet<string> NativeWindows;

    public static FocusIdentityResult Available(
        string runtimeId,
        string fingerprint,
        IEnumerable<string> nativeWindows)
    {
        return new FocusIdentityResult
        {
            State = FocusIdentityState.Available,
            Value = "uia2|" + runtimeId + "|" + (fingerprint ?? ""),
            RuntimeId = runtimeId,
            Fingerprint = fingerprint,
            NativeWindows = new HashSet<string>(nativeWindows, StringComparer.Ordinal)
        };
    }

    public static FocusIdentityResult Unavailable()
    {
        return new FocusIdentityResult { State = FocusIdentityState.Unavailable };
    }

    public static FocusIdentityResult Degraded()
    {
        return new FocusIdentityResult { State = FocusIdentityState.Degraded };
    }

    public bool SameLogicalElement(FocusIdentityResult other)
    {
        if (other == null
            || State != FocusIdentityState.Available
            || other.State != FocusIdentityState.Available)
            return false;
        // The fingerprint is a fallback for provider node replacement. A live
        // UIA element can move or change class without changing its identity.
        if (RuntimeId == other.RuntimeId)
            return true;
        return !string.IsNullOrEmpty(Fingerprint)
            && Fingerprint == other.Fingerprint;
    }

    public bool BelongsTo(string window, string focus)
    {
        if (NativeWindows == null)
            return false;
        return focus != "0" && focus != window
            ? NativeWindows.Contains(focus)
            : NativeWindows.Contains(window);
    }

    public FocusIdentityComparison Compare(string expected)
    {
        string expectedRuntimeId;
        string expectedFingerprint;
        if (!TryParse(expected, out expectedRuntimeId, out expectedFingerprint))
            return FocusIdentityComparison.Unavailable;
        if (expectedRuntimeId == RuntimeId)
            return FocusIdentityComparison.Match;
        if (string.IsNullOrEmpty(expectedFingerprint)
            || string.IsNullOrEmpty(Fingerprint))
            return FocusIdentityComparison.Unavailable;
        return expectedFingerprint == Fingerprint
            ? FocusIdentityComparison.Match
            : FocusIdentityComparison.Changed;
    }

    private static bool TryParse(
        string value,
        out string runtimeId,
        out string fingerprint)
    {
        runtimeId = null;
        fingerprint = null;
        if (string.IsNullOrEmpty(value))
            return false;
        if (value.StartsWith("uia2|", StringComparison.Ordinal))
        {
            var separator = value.IndexOf('|', 5);
            if (separator < 0)
                return false;
            runtimeId = value.Substring(5, separator - 5);
            fingerprint = value.Substring(separator + 1);
            return runtimeId.Length > 0;
        }
        if (value.StartsWith("uia:", StringComparison.Ordinal))
        {
            runtimeId = value;
            return true;
        }
        return false;
    }
}

internal enum FocusIdentityComparison
{
    Match,
    Changed,
    Unavailable
}

internal sealed class FocusReader : IDisposable
{
    private readonly object _lock = new object();
    private BlockingCollection<Job> _jobs;
    private Thread _worker;
    private bool _busy;

    public FocusIdentityResult QueryIdentity(int timeoutMs)
    {
        var job = new Job();
        lock (_lock)
        {
            EnsureWorker();
            // A busy UIA worker is not replaced. If it hangs, focus validation
            // stays degraded until the host is restarted.
            if (_busy)
                return FocusIdentityResult.Degraded();
            _busy = true;
            try
            {
                _jobs.Add(job);
            }
            catch
            {
                _busy = false;
                return FocusIdentityResult.Degraded();
            }
        }
        if (job.Done.Wait(timeoutMs))
            return job.Result;
        return FocusIdentityResult.Degraded();
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
        if (_worker != null && _worker.IsAlive)
            return;
        _busy = false;
        _jobs = new BlockingCollection<Job>(new ConcurrentQueue<Job>());
        var jobs = _jobs;
        _worker = new Thread(() => Work(jobs))
        {
            IsBackground = true,
            Name = "uia-focus"
        };
        _worker.SetApartmentState(ApartmentState.STA);
        _worker.Start();
    }

    private void Work(BlockingCollection<Job> jobs)
    {
        foreach (var job in jobs.GetConsumingEnumerable())
        {
            try
            {
                job.Result = FocusIdentity();
            }
            catch
            {
                job.Result = FocusIdentityResult.Degraded();
            }
            finally
            {
                job.Done.Set();
                lock (_lock)
                    _busy = false;
            }
        }
    }

    private static FocusIdentityResult FocusIdentity()
    {
        var element = AutomationElement.FocusedElement;
        if (element == null)
            return FocusIdentityResult.Unavailable();
        var runtimeId = element.GetRuntimeId();
        if (runtimeId == null || runtimeId.Length == 0)
            return FocusIdentityResult.Unavailable();
        var identity = new StringBuilder("uia");
        foreach (var value in runtimeId)
            identity.Append(':').Append(value);
        var current = element.Current;
        return FocusIdentityResult.Available(
            identity.ToString(),
            Fingerprint(current),
            NativeWindows(element));
    }

    private static IEnumerable<string> NativeWindows(AutomationElement element)
    {
        var result = new HashSet<string>(StringComparer.Ordinal);
        var current = element;
        for (var depth = 0; current != null && depth < 64; depth += 1)
        {
            var handle = current.Current.NativeWindowHandle;
            if (handle != 0)
                result.Add(handle.ToString(CultureInfo.InvariantCulture));
            current = TreeWalker.ControlViewWalker.GetParent(current);
        }
        return result;
    }

    private static string Fingerprint(
        AutomationElement.AutomationElementInformation current)
    {
        var bounds = current.BoundingRectangle;
        var controlType = current.ControlType;
        if (current.ProcessId <= 0
            || controlType == null
            || bounds.IsEmpty
            || bounds.Width <= 0
            || bounds.Height <= 0)
            return null;
        var automationId = current.AutomationId ?? "";
        var className = current.ClassName ?? "";
        if (automationId.Length == 0 && className.Length == 0)
            return null;
        var description = new StringBuilder();
        foreach (var part in new[]
        {
            current.ProcessId.ToString(CultureInfo.InvariantCulture),
            controlType.Id.ToString(CultureInfo.InvariantCulture),
            current.FrameworkId ?? "",
            automationId,
            className,
            Coordinate(bounds.Left),
            Coordinate(bounds.Top),
            Coordinate(bounds.Width),
            Coordinate(bounds.Height)
        })
            description.Append(part.Length).Append(':').Append(part);
        using (var hash = SHA256.Create())
        {
            var digest = hash.ComputeHash(Encoding.UTF8.GetBytes(description.ToString()));
            return Convert.ToBase64String(digest);
        }
    }

    private static string Coordinate(double value)
    {
        return Math.Round(value, MidpointRounding.AwayFromZero)
            .ToString(CultureInfo.InvariantCulture);
    }

    private sealed class Job
    {
        public readonly ManualResetEventSlim Done = new ManualResetEventSlim(false);
        public FocusIdentityResult Result = FocusIdentityResult.Degraded();
    }
}
