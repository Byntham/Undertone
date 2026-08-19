using System;

internal static class FocusIdentityTests
{
    public static int Main()
    {
        try
        {
            RejectsSingleAvailableSample();
            AcceptsMajorityAfterTransientSample();
            AcceptsMajorityAroundTransientSample();
            AcceptsNewStableIdentity();
            RejectsUnstableIdentities();
            DoesNotCorroborateAcrossInputOrHandleChanges();
            RejectsIdentityFromAnotherWindow();
            RejectsSiblingElementFromSameWindow();
            AcceptsRepeatedUnavailableSamples();
            ComparesRuntimeIdsAndFingerprintsSafely();
            Console.WriteLine("Native focus identity tests passed");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }

    private static void RejectsSingleAvailableSample()
    {
        var samples = new FocusSampleAccumulator();
        AssertNull(Observe(samples, Available("A", "field"), 1, "window"));
    }

    private static void AcceptsMajorityAfterTransientSample()
    {
        var samples = new FocusSampleAccumulator();
        AssertNull(Observe(samples, Available("transient", "pane"), 1, "window"));
        AssertNull(Observe(samples, Available("stable", "field"), 1, "window"));
        var result = Observe(samples, Available("stable", "field"), 1, "window");
        AssertEqual("stable", result.FocusIdentity.RuntimeId);
    }

    private static void AcceptsMajorityAroundTransientSample()
    {
        var samples = new FocusSampleAccumulator();
        AssertNull(Observe(samples, Available("stable", "field"), 1, "window"));
        AssertNull(Observe(samples, Available("transient", "pane"), 1, "window"));
        var result = Observe(samples, Available("stable", "field"), 1, "window");
        AssertEqual("stable", result.FocusIdentity.RuntimeId);
    }

    private static void AcceptsNewStableIdentity()
    {
        var samples = new FocusSampleAccumulator();
        AssertNull(Observe(samples, Available("old", "old-field"), 1, "window"));
        AssertNull(Observe(samples, Available("new", "new-field"), 1, "window"));
        var result = Observe(samples, Available("new", "new-field"), 1, "window");
        AssertEqual("new", result.FocusIdentity.RuntimeId);
    }

    private static void RejectsUnstableIdentities()
    {
        var samples = new FocusSampleAccumulator();
        AssertNull(Observe(samples, Available("A", "field-A"), 1, "window"));
        AssertNull(Observe(samples, Available("B", "field-B"), 1, "window"));
        AssertNull(Observe(samples, Available("C", "field-C"), 1, "window"));
    }

    private static void DoesNotCorroborateAcrossInputOrHandleChanges()
    {
        var generationSamples = new FocusSampleAccumulator();
        AssertNull(Observe(generationSamples, Available("A", "field"), 1, "window"));
        AssertNull(Observe(generationSamples, Available("A", "field"), 2, "window"));
        AssertNull(Observe(generationSamples, Available("A", "field"), 2, "window"));

        var handleSamples = new FocusSampleAccumulator();
        AssertNull(Observe(handleSamples, Available("A", "field"), 1, "window-1"));
        AssertNull(Observe(handleSamples, Available("A", "field"), 1, "window-2"));
        AssertNull(Observe(handleSamples, Available("A", "field"), 1, "window-2"));
    }

    private static void AcceptsRepeatedUnavailableSamples()
    {
        var samples = new FocusSampleAccumulator();
        AssertNull(Observe(samples, FocusIdentityResult.Unavailable(), 1, "window"));
        AssertNotNull(Observe(samples, FocusIdentityResult.Unavailable(), 1, "window"));
    }

    private static void RejectsIdentityFromAnotherWindow()
    {
        var samples = new FocusSampleAccumulator();
        var identity = FocusIdentityResult.Available(
            "A",
            "field",
            new[] { "other-window" });
        AssertNull(Observe(samples, identity, 1, "window"));
        AssertNull(Observe(samples, identity, 1, "window"));
    }

    private static void RejectsSiblingElementFromSameWindow()
    {
        var samples = new FocusSampleAccumulator();
        var identity = FocusIdentityResult.Available(
            "A",
            "field",
            new[] { "window" });
        AssertNull(Observe(samples, identity, 1, "window"));
        AssertNull(Observe(samples, identity, 1, "window"));
    }

    private static void ComparesRuntimeIdsAndFingerprintsSafely()
    {
        var expected = Available("old-runtime", "same-field");
        AssertEqual(
            FocusIdentityComparison.Match,
            Available("new-runtime", "same-field").Compare(expected.Value));
        AssertEqual(
            FocusIdentityComparison.Changed,
            Available("new-runtime", "other-field").Compare(expected.Value));
        AssertEqual(
            FocusIdentityComparison.Unavailable,
            Available("new-runtime", null).Compare(expected.Value));
        AssertEqual(
            FocusIdentityComparison.Match,
            Available("old-runtime", "other-field").Compare(expected.Value));
    }

    private static FocusIdentityResult Available(
        string runtimeId,
        string fingerprint)
    {
        return FocusIdentityResult.Available(
            runtimeId,
            fingerprint,
            new[] { "window", "focus" });
    }

    private static ForegroundInfo Observe(
        FocusSampleAccumulator samples,
        FocusIdentityResult identity,
        long generation,
        string window)
    {
        var before = Foreground(window, FocusIdentityResult.Degraded());
        var after = Foreground(window, identity);
        return samples.Observe(before, after, generation, generation);
    }

    private static ForegroundInfo Foreground(
        string window,
        FocusIdentityResult identity)
    {
        return new ForegroundInfo
        {
            Window = window,
            Focus = "focus",
            FocusIdentity = identity
        };
    }

    private static void AssertNull(object value)
    {
        if (value != null)
            throw new InvalidOperationException("Expected null");
    }

    private static void AssertNotNull(object value)
    {
        if (value == null)
            throw new InvalidOperationException("Expected a value");
    }

    private static void AssertEqual<T>(T expected, T actual)
    {
        if (!object.Equals(expected, actual))
            throw new InvalidOperationException(
                "Expected " + expected + ", received " + actual);
    }
}
