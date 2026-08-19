using System.Collections.Generic;

internal sealed class FocusSampleAccumulator
{
    private const int RequiredSamples = 2;
    private readonly List<Candidate> _candidates = new List<Candidate>();
    private ForegroundInfo _baseline;
    private long _generation;
    private bool _invalid;

    public ForegroundInfo Observe(
        ForegroundInfo before,
        ForegroundInfo after,
        long generationBefore,
        long generationAfter)
    {
        if (_invalid)
            return null;
        if (generationBefore != generationAfter || !SameHandles(before, after))
        {
            _invalid = true;
            return null;
        }
        if (_baseline == null)
        {
            _baseline = after;
            _generation = generationAfter;
        }
        else if (_generation != generationAfter || !SameHandles(_baseline, after))
        {
            _invalid = true;
            return null;
        }
        if (after.FocusIdentity.State == FocusIdentityState.Degraded
            || (after.FocusIdentity.State == FocusIdentityState.Available
                && !after.FocusIdentity.BelongsTo(after.Window, after.Focus)))
            return null;

        foreach (var candidate in _candidates)
        {
            if (!SameIdentity(candidate.Identity, after.FocusIdentity))
                continue;
            candidate.Count += 1;
            return candidate.Count >= RequiredSamples ? after : null;
        }

        _candidates.Add(new Candidate
        {
            Identity = after.FocusIdentity,
            Count = 1
        });
        return null;
    }

    private static bool SameHandles(ForegroundInfo left, ForegroundInfo right)
    {
        return left.Window == right.Window
            && left.Focus == right.Focus;
    }

    private static bool SameIdentity(
        FocusIdentityResult left,
        FocusIdentityResult right)
    {
        if (left.State != right.State)
            return false;
        if (left.State == FocusIdentityState.Available)
            return left.SameLogicalElement(right);
        return left.State == FocusIdentityState.Unavailable;
    }

    private sealed class Candidate
    {
        public FocusIdentityResult Identity;
        public int Count;
    }
}
