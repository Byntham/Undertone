using System;
using System.Collections.Concurrent;
using System.Text;
using System.Threading;
using System.Windows.Automation;

// Reads only UI Automation's opaque runtime ID. It never reads control text.
internal sealed class FocusReader : IDisposable
{
    private readonly object _lock = new object();
    private BlockingCollection<Job> _jobs;
    private Thread _worker;
    private bool _busy;

    public string QueryIdentity(int timeoutMs)
    {
        var job = new Job();
        lock (_lock)
        {
            EnsureWorker();
            if (_busy)
                return null;
            _busy = true;
            try
            {
                _jobs.Add(job);
            }
            catch
            {
                _busy = false;
                return null;
            }
        }
        if (job.Done.Wait(timeoutMs))
            return job.Identity;
        job.Cancelled = true;
        return null;
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
                if (!job.Cancelled)
                    job.Identity = FocusIdentity();
            }
            catch
            {
                job.Identity = null;
            }
            finally
            {
                job.Done.Set();
                lock (_lock)
                    _busy = false;
            }
        }
    }

    private static string FocusIdentity()
    {
        var element = AutomationElement.FocusedElement;
        if (element == null)
            return null;
        var runtimeId = element.GetRuntimeId();
        if (runtimeId == null || runtimeId.Length == 0)
            return null;
        var identity = new StringBuilder("uia");
        foreach (var value in runtimeId)
            identity.Append(':').Append(value);
        return identity.ToString();
    }

    private sealed class Job
    {
        public readonly ManualResetEventSlim Done = new ManualResetEventSlim(false);
        public volatile bool Cancelled;
        public string Identity;
    }
}
