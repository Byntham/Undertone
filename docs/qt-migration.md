# Qt (PySide6) migration plan

Status: **decided-pending-owner-go** after the Phase 1 spike (2026-07-16).
Phase 0 hardening and the spike are committed; nothing below has started.

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

## Estimate

Phase 2 ≈ one working session; Phase 3 ≈ one to two (Providers is half
the work); Phase 4 ≈ one. Wall-clock dominated by verification loops,
not code.
