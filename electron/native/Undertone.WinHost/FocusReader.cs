using System;
using System.Collections.Concurrent;
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

    public static FocusIdentityResult Available(string value)
    {
        return new FocusIdentityResult
        {
            State = FocusIdentityState.Available,
            Value = value
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
        return FocusIdentityResult.Available(identity.ToString());
    }

    private sealed class Job
    {
        public readonly ManualResetEventSlim Done = new ManualResetEventSlim(false);
        public FocusIdentityResult Result = FocusIdentityResult.Degraded();
    }
}
