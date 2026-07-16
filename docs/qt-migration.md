# Qt (PySide6) migration plan

Status: **COMPLETE** (2026-07-16) — all four phases landed on the
qt-migration branch. This document remains as the migration record and
for the learning notes.

## Why (one paragraph)

canvasui.py reached visual and perf parity with a real toolkit by
reimplementing one — 4.6k lines (~45% of the app) serve one settings
window, and every future control is a mini-project carrying its own
focus/IME/accessibility bugs. Qt renders the whole window as one surface
(the property canvasui was built to obtain), ships the widget behavior
layer, and exposes real controls to UIA — which Undertone itself depends
on to read other apps. This is a learning-project port, done for the
foundation, not because the current window is broken.

## Spike results (spikes/qt_spike.py, PySide6 6.11.1)

| Measure | Qt spike | canvasui today (same machine) |
|---|---|---|
| Resize storm median | **3.6 ms/step** (p95 4.2, max 8.4) | 4.0–7.2 ms/step per section |
| Custom rendering code | 0 lines (QSS + 40-line painted pill) | 2,361 lines (canvasui.py) |
| Perf gate | n/a | <18 ms/step |
| One-file exe | 44 MB (default excludes) | ~20 MB today |

Visual verdict (ui-verifier): One-Dark ladder, rounded cards, sidebar,
and the translucent pill all reproduce cleanly; no clipping at 760 or
1150 px. Caveat: the spike window is less dense than the real settings
window — treat the number as indicative, not a gate pass.

## Ground rules

- All work on a `qt-migration` branch; `main` stays shippable. Merge only
  after full parity verification.
- One commit per verified milestone, as usual. Never push.
- The engine modules are NOT touched: recorder, transcriber, cleanup,
  textproc, injector, caretctx, hotkey, localstt, config, autostart.
- theme.py stays the single palette source; the QSS is generated from it.
- Learning checkpoints: each phase ends with a short written explanation
  of the Qt concepts it introduced (signals/slots, QSS, model/view,
  animations) against how the Tk version did it.

## Phase 2 — Shell port (QApplication owns the process)

Tk and Qt event loops can't share a process, so the shell moves as one
unit: root, tray, overlay. The settings window is dark during this phase
(branch-only state).

1. `main.py`: QApplication replaces the Tk root. `App._post`/`_commands`
   queue + 50 ms poller → a `Dispatcher(QObject)` with a
   `Signal(object)` that runs callables on the main thread (queued
   connections are the Qt-native version of the same pattern; the
   pipeline worker and hook threads keep the exact same contract).
2. Tray: pystray → `QSystemTrayIcon` (menu: Pause dictation / Settings /
   Quit; red-tinted recording icon swap; tooltip = hotkey). Drops the
   pystray thread entirely — tray signals arrive on the main thread.
3. Overlay: port to a frameless `Qt.Tool` window with
   `WA_TranslucentBackground` + `WA_ShowWithoutActivating`. Replaces the
   whole UpdateLayeredWindow/premultiplied-BGRA path with QPainter.
   States to port: recording bars (+ locked accent variant),
   transcribing animation, message pill (error/warn/plain), "still
   transcribing" escalation, fades (QPropertyAnimation on
   windowOpacity — the SourceConstantAlpha analog). Click-through +
   no-activate stay as two ctypes style bits (private WinDLL instance).
   The two Tk-era invariants (never -alpha; frame-before-deiconify)
   dissolve; verify no first-show flash regardless.
4. `sounds`, gestures, hotkeys, pipeline: unchanged. Overlay calls from
   the pipeline thread go through the same show_* methods, now emitting
   signals instead of queueing.

Verify: dictation end-to-end on the branch (record → pill states →
paste), tray menu round-trip, Esc cancel, hands-free lock pill, no
first-frame flash, CPU idle when idle (animation timers stop).

## Phase 3 — Settings port, section by section

Scaffold: one `QWidget` window — fixed sidebar + `QStackedWidget` of
scrollable sections; QSS generated from theme.py; dark titlebar via DWM
attribute (spike-proven). Then sections in rising complexity, one
commit each, ui-verifier parity per section:

1. **About** (static) — proves the scaffold.
2. **General** (combos, shortcut-capture field, toggles) — build the two
   small custom widgets: a QSS/painted toggle switch and the
   capture-shortcut field (must keep the `_pause_hotkey`/`_capture_active`
   interlock with main.py).
3. **Formatting** (toggles + hints, chat-apps note).
4. **Dictionary** (QListView + model, add/edit/delete rows; ~200-row
   virtualization is free).
5. **History** (model with live refresh via dispatcher, expandable raw
   view, retry action wired to `App._retry_failed`).
6. **Providers + Get started** (provider/key/model fields per provider,
   test-key workers, mic picker + level meter (QTimer-driven painted
   bar), practice box, and the local-STT card: install progress,
   Load/Eject, runtime state — worker threads post via signals, same
   `_queue`/`_drain` semantics).

Verify per section: ui-verifier screenshot parity vs the Tk window at
760/max width, behavior checklist, no dead settings key (every config
field reachable and autosaving via `_apply`-equivalent).

## Phase 4 — Teardown, tests, packaging

1. Delete canvasui.py, old settingsui.py, old overlay.py; strip ui.py to
   the shared tables (LANGUAGES, PROVIDERS_UI, SECTIONS, pretty_combo)
   or fold them into a `uidata.py`.
2. theme.py: palette stays; `init_dpi()`/`sc()` retire (Qt is per-monitor
   DPI aware out of the box — remove the import-time scaling note from
   AGENTS.md).
3. Tests: port perf_settingsui/perf_canvasui to a Qt resize-storm harness
   (same 18 ms/step budget, storm code exists in the spike); update
   test_e2e and test_focus_return (Qt windows are native HWNDs, so window
   tracking survives; the fake-transcribe injection point is unchanged);
   add an offscreen instantiation smoke for the settings window.
4. Packaging: undertone.spec gains PySide6 with aggressive excludes
   (QtNetwork/QtQml/QtQuick/QtPdf/translations — only QtCore/QtGui/
   QtWidgets are used). Decide onefile vs onedir HERE: PySide6 onefile
   unpacks ~100+ MB to temp on every cold launch (slow start for a tray
   app that autostarts at logon); onedir starts fast but ships a folder.
   Measure both before choosing.
5. requirements.txt: + PySide6; − pystray; Pillow likely stays only for
   icon asset generation (assess).
6. Rewrite the AGENTS.md UI sections (overlay/settings invariants are
   toolkit-specific and mostly dissolve; the threading section's
   queue-poller language becomes signals/queued-connections).

Verify: full keyless test suite, E2E on an idle desktop, packaged exe
smoke (fresh %LOCALAPPDATA%, autostart registration, elevated-paste
note), min/max window sweeps, 150% DPI check.

## Risks and mitigations

- **Exe size / onefile cold start** — the one user-visible regression
  candidate; measured in Phase 4 with excludes before deciding format.
- **Feel-parity tail** (focus rings, motion restraint, pill timing) —
  budget explicit polish passes; the old window's screenshots are the
  reference.
- **Shortcut capture vs global hooks** — the `keyboard` lib is
  toolkit-agnostic, but re-verify the capture/pause interlock early
  (Phase 3.2, not last).
- **Desktop-idle tests** — E2E/caretctx runs need the machine idle; park
  them for a quiet window rather than trusting a busy-desktop failure.
- **DPI**: Qt scales automatically; overlay positioning math must use
  logical coordinates (devicePixelRatio ≠ 1 on scaled displays).

## Phase 2 learning notes (Tk shell → Qt shell)

What each Tk-era mechanism became, and why:

- **`queue.Queue` + `root.after(50)` poller → one `Signal(object)`.**
  Emitting a Qt signal from any thread is safe; when the emitter isn't
  the main thread, Qt automatically queues the delivery onto the main
  loop (a "queued connection"). Same guarantee the queue+poller gave —
  UI touched only by the main thread — but event-driven instead of
  polled: no 50 ms latency, no idle wakeups, ~10 lines total
  (`_Dispatcher` in main.py). The pattern generalizes: any worker→UI
  hop in Phase 3 is "emit a signal carrying data."
- **pystray → QSystemTrayIcon, and a thread disappears.** pystray ran
  its own loop on its own thread, so every menu callback had to be
  `_post`ed to Tk and every tray mutation wrapped in try/except.
  QSystemTrayIcon lives on the main loop: menu actions arrive on the
  main thread, `setIcon`/`setToolTip` are plain calls, and the
  checkable "Pause dictation" QAction replaces the `update_menu()`
  dance. The one remaining hop: `_set_tray_icon` is called from the
  keyboard hook thread, so it posts through the dispatcher.
- **UpdateLayeredWindow (250 lines of GDI) → `WA_TranslucentBackground`
  + `paintEvent`.** Qt gives a per-pixel-alpha window natively; the
  Pillow supersampling became `QPainter.Antialiasing`; premultiplied
  BGRA DIB sections became "just paint." Both hard-won invariants
  dissolved: fading is `windowOpacity` (Qt's SourceConstantAlpha), and
  no-stale-flash is handled by laying out before `show()` plus fading
  in from 0. Click-through/no-focus needed zero ctypes:
  `WindowTransparentForInput` + `WindowDoesNotAcceptFocus` flags.
- **`root.after` id juggling → generation-guarded `QTimer.singleShot`.**
  The old code cancelled after-ids defensively; the port keeps the
  (better) generation counter it already had and drops the id
  bookkeeping — a stale auto-hide/escalate fires and no-ops.
- **Manual binary-search ellipsizing → `QFontMetrics.elidedText`.**
  Ten lines became one call. Emblematic of the whole port: the Qt pill
  is ~290 lines vs ~470, and the deleted 180 were exactly the
  platform-plumbing lines.
- **DPI**: `theme.init_dpi()`/`sc()` are gone from the shell — Qt is
  per-monitor DPI aware on its own and all design measures are logical
  pixels. (theme.py keeps them while canvasui/settingsui still exist.)

Verification: six pill states screen-captured from both renderers came
out width-identical (the layout math survived translation); ui-verifier
judged the pairs; full-App smoke on an f13 hotkey booted, drove every
state, swapped tray icons cross-thread, and quit clean.

## Phase 3 learning notes (canvas settings → Qt widgets)

- **2,285 lines → ~1,320, and the missing 1,000 are the widget layer.**
  settingsqt.py contains no layout engine, no focus manager, no shared
  edit overlay, no ListView virtualization, no clip() methods — every
  behavior method (capture flow, key tests, local card, history
  fingerprint poll) ported nearly 1:1, while the rendering half of the
  old file simply has no counterpart. canvasui.py (2,361 lines) has no
  replacement at all; QSS + five small custom widgets (Toggle, Meter,
  NavItem, ElideLabel, ListRow ~120 lines total) cover it.
- **The worker pattern got simpler, not different.** Old: worker thread →
  `self._queue.put(...)` → 50 ms `root.after` drain → dispatch table.
  New: worker thread → `signal.emit(...)` → slot. Same threads, same
  contracts (capture, STT/cleanup tests, local install/load/eject with
  per-percent progress), minus the poller and the string-keyed dispatch.
- **Section lifetime = widget lifetime.** The old code hand-cancelled
  after-ids per section (`_cancel_section_tasks`). In Qt, each section's
  QTimers are parented to the section widget, so switching sections
  deletes them with it — the mic-test recorder is the one resource that
  still needs explicit stop (hardware, not a widget).
- **Two real rendering lessons the verifier caught:**
  (1) A stylesheet-styled QComboBox loses its native chevron — QSS
  `::down-arrow` needs an image, generated at runtime in %TEMP% since
  QSS url() wants a file. (2) A QLabel that elides by setText-on-resize
  fights the layout (its own text change re-triggers sizing, pushing
  siblings out); eliding at paint time with an Ignored size policy is
  the stable idiom.
- **Old-code archaeology paid off once**: `_local_model_name()` looked
  redundant ("override or default") and got simplified in the port —
  which silently flipped the local card to "Not installed". The verifier
  flagged the state mismatch as a fixture difference; it was a real
  regression. Parity references catch behavior, not just pixels.
- **What Qt gave for free this phase**: geometry clamping via
  QScreen.availableGeometry (replacing a ctypes EnumDisplayMonitors
  callback), password echo modes, link labels, elided text metrics,
  scroll physics, focus traversal, and IME-correct text fields.

## Phase 4 learning notes (teardown, tests, packaging)

- **The ledger**: canvasui.py (2,361) + old settingsui.py (2,285) +
  overlay's GDI half deleted; replacements are settingsui.py (1,910),
  overlay.py (337). Net ≈ −2,700 lines, and what remains is almost all
  product behavior rather than rendering machinery. theme.py shrank to
  a pure palette (27 lines) — Qt owns DPI, so `sc()`/`init_dpi()` and
  their import-order constraint vanished.
- **Perf gate ported and passed**: the real Qt window relayouts at
  3.2–5.0 ms/step median per section against the same <18 ms budget the
  canvas framework was engineered to hit (canvasui measured 4.0–7.2 on
  this machine the same day).
- **Packaging reality vs. fear**: with only QtCore/QtGui/QtWidgets and
  an explicit exclude list for the rest of the Qt zoo, the one-file exe
  is 56 MB (was ~20). The dreaded onefile cold-start tax measured under
  1 s to "App started" on this machine's NVMe — onefile stays, onedir
  unneeded. First launch also proved the exclude list correct (the app
  boots frozen; an over-aggressive exclude fails exactly here, at
  import time, which is why the frozen smoke matters).
- **E2E harnesses survived almost untouched**: two lines each
  (`root.mainloop()` → `qapp.exec()`, `root.destroy` → `_quit`) — the
  harness drives the app through OS-level input injection and window
  focus, which is exactly why it's toolkit-agnostic.
- **pystray left requirements.txt**; Pillow stays (icon/glyph drawing,
  recorder-adjacent image work), bridged to Qt via PNG bytes.

## Estimate

Phase 2 ≈ one working session; Phase 3 ≈ one to two (Providers is half
the work); Phase 4 ≈ one. Wall-clock dominated by verification loops,
not code.
