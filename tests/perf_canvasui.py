"""Interactive-resize performance gate for canvasui.py.

Run with: .venv\Scripts\python.exe tests\perf_canvasui.py
"""

import os
import statistics
import sys
import time
import tkinter as tk

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import canvasui  # noqa: E402
import theme  # noqa: E402
from demo_canvasui import build_demo_pane  # noqa: E402


def main():
    theme.init_dpi()
    root = tk.Tk()
    root.geometry(
        f"{theme.sc(780)}x{theme.sc(724)}+{theme.sc(40)}+{theme.sc(40)}")
    try:
        demo = build_demo_pane(root)
        root.update_idletasks()
        root.update()
        demo["scene"].relayout()
        root.update()

        misses_before = canvasui.CAP_CACHE.misses
        samples = []
        for step in range(60):
            amount = step / 59
            width = theme.sc(round(780 + (1050 - 780) * amount))
            height = theme.sc(round(724 + (820 - 724) * amount))
            started = time.perf_counter()
            root.geometry(f"{width}x{height}")
            root.update()
            samples.append((time.perf_counter() - started) * 1000)

        median = statistics.median(samples)
        misses = canvasui.CAP_CACHE.misses - misses_before
        print(f"median: {median:.3f} ms/step")
        print(f"min/max: {min(samples):.3f}/{max(samples):.3f} ms")
        print(f"cap-cache misses during storm: {misses}")
        # Native canvas redraw costs ~35-45us/item on this machine; this
        # 188-item stress pane measures ~17ms/step against an empty-window
        # floor of ~8ms, and profiling shows Python-side layout is <1ms with
        # ~15 Tcl calls/step, so the rest is Tk's repaint — not reducible
        # from Python. Machine variance is ~±2ms run to run, so the gate
        # carries margin: it exists to catch regressions in kind (embedded
        # HWNDs, cache misses, non-incremental relayout), which show up as
        # 2x jumps, not 1-2ms creep. Real sections gate in
        # tests/perf_settingsui.py; lists virtualize to bound item count.
        assert median < 20.0, f"resize median {median:.3f}ms exceeds 20ms"
        assert misses == 0, f"{misses} cap-cache misses occurred during resize"
    finally:
        root.destroy()


if __name__ == "__main__":
    main()
