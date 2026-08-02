# Electron + TypeScript migration

Status: **IN PROGRESS** (started 2026-08-02)

Milestone 1, the isolated TypeScript foundation, completed 2026-08-02.

The current Python/PySide6 application remains the production reference until
the packaged Electron application passes the complete parity gate. The
migration is a parallel replacement, not a released Electron-to-Python
sidecar: keeping two production runtimes would add an IPC and packaging layer
that exists only to be deleted later.

## Scope and decisions

- Windows remains the only supported operating system.
- Product and domain code moves to strict TypeScript.
- Settings will use React once the renderer port begins; the small overlay can
  remain plain TypeScript with Canvas/CSS.
- Low-level hooks, UI Automation, focus restoration, input injection, DPAPI
  compatibility, and job objects live behind one small native Windows host.
- A standalone Windows host is preferred over an in-process addon so a native
  crash or hung COM provider cannot take down Electron. The host is C# targeting
  the Windows-provided .NET Framework: the reference machine already has the
  compiler, runtime, and UI Automation assemblies, avoiding a Rust + Visual
  Studio toolchain installation and avoiding a bundled managed runtime.
- `%APPDATA%\Undertone` and `%LOCALAPPDATA%\Undertone` remain authoritative.
  Existing configuration, encrypted keys, models, and runtime state must not
  be copied to a new product directory.
- The first Electron release keeps the existing `dpapi:` key representation so
  rolling back to the Python build does not invalidate stored credentials.
- macOS/Linux support, UI redesign, new providers, persistent history, and
  auto-update changes are out of scope.

## Target boundaries

```text
C# Windows host
  hooks | UIA/Win32 context | focus | SendInput | DPAPI | job objects
                              |
                        typed local IPC
                              |
Electron main (TypeScript)
  config | serial pipeline | history | tray | local-engine lifecycle
       |                    |                     |
settings renderer     overlay renderer      audio renderer
React + TypeScript    Canvas/CSS             AudioWorklet
```

The renderer processes are sandboxed and context-isolated. They receive only
task-specific APIs through preload scripts; generic IPC, filesystem access,
provider keys, and native-host handles are never exposed to renderer code.

## Current baseline

Reference commit: `a223ee5` (`Recognize empty embedded editors`).

| Measure | Baseline |
|---|---:|
| Production Python | 6,604 lines |
| Python tests | 2,138 lines |
| Settings implementation | 2,229 lines |
| Current packaged executable | approximately 56 MB (last recorded Qt smoke) |
| Settings resize gate | less than 18 ms/step |
| Caret-context public timeout | 150 ms |
| Overlay recording tick | 33 ms |
| Cleanup default timeout | 2.5 s |

The worktree does not currently contain the project `.venv`, and no suitable
Python 3.11 launcher is installed. Therefore the existing Python test suite and
live startup measurements cannot be rerun in this checkout yet. This is an
environment gap, not a changed application result; the tests remain the parity
source and must be run before any production cutover.

Provisional Electron budgets, to be accepted or revised from the packaged
vertical spike:

- idle CPU below 0.5%;
- hotkey-to-recording feedback below 100 ms;
- caret-context calls still bounded at 150 ms;
- cold launch below 2 seconds on the reference machine;
- idle private working set below 200 MB;
- packaged download below roughly 180 MB.

## Parity contract

### Input and recording

- [ ] Right-Ctrl and arbitrary multi-key shortcuts expose distinct down/up
      transitions globally.
- [ ] Auto-repeat does not generate duplicate transitions.
- [x] Hold/release, short-tap discard, release-anchored double-tap lock,
      dedicated toggle, and Esc cancel match `tests/test_gestures.py`.
- [ ] Shortcut capture suspends all configured shortcuts and rejects duplicates.
- [ ] Undertone's injected keys do not invalidate insertion memory; genuine
      typing and mouse clicks do.
- [ ] Audio is 16 kHz, mono, signed 16-bit PCM WAV and the existing minimum
      duration remains enforced.
- [ ] Device selection is stored and resolved by microphone name.

### Pipeline and formatting

- [ ] One FIFO worker processes dictate, retry, and re-paste jobs.
- [ ] Each job snapshots config when it leaves the queue.
- [ ] Target HWND is captured at recording end and restored before context read
      and again after cleanup.
- [ ] UIA -> Win32 edit control -> insertion-memory fallback order is preserved.
- [ ] Password controls are never read.
- [ ] Left context may reach cleanup; right context remains local.
- [ ] Corrections, capitalization, spacing, punctuation seams, chat-period
      removal, and context-echo removal match the Python fixtures.
- [ ] Clipboard restoration and insertion memory remain generation guarded.
- [ ] Any paste/refocus failure places text on the clipboard and in history.

### Providers and local engines

- [ ] xAI, OpenAI, OpenRouter, and local request shapes match
      `tests/test_providers.py`.
- [ ] Vocabulary biasing remains xAI-only.
- [ ] Cleanup failure/timeout silently falls back to deterministic rules.
- [ ] Local cleanup never blocks the current dictation on a cold model.
- [ ] Existing pinned downloads, hashes, CPU/CUDA fallback, VAD, model
      overrides, idle eject, and unified residency settings are preserved.
- [ ] Local child processes die on normal exit and forced parent termination.

### Shell and settings

- [ ] Tray state, pause semantics, tooltip, single-instance behavior, and all
      menu actions match.
- [ ] Overlay never takes focus or mouse input and has no first-frame flash.
- [ ] All recording, locked, transcribing, slow, warning, error, and paste
      confirmation states match.
- [ ] Every current config field remains reachable and autosaves.
- [ ] Onboarding, provider tests, microphone meter, practice dictation,
      dictionary, history/retry, local cards, and developer controls match.
- [ ] Settings and overlay pass screen-based checks at 100%, 150%, and 200% DPI.

### Upgrade and distribution

- [ ] Existing config is backed up once, loaded without loss, and saved atomically.
- [ ] Existing `dpapi:` keys remain readable by both Electron and the rollback
      Python release.
- [ ] Existing local models are reused without downloading.
- [ ] Legacy and current autostart registrations migrate without duplication.
- [ ] Portable and per-user NSIS artifacts pass fresh-install and upgrade smoke.
- [ ] The production artifact contains no Python runtime or source.

## Milestones

1. **Foundation** - migration record, isolated Electron workspace, strict build,
   test runner, and gesture parity.
2. **Vertical spike** - packaged tray app proves raw global input, hidden audio,
   non-focusing overlay, UIA context, target restoration, paste, and supervised
   dummy child-process cleanup.
3. **Portable core** - formatting, config migration, provider shapes, cleanup,
   and local-runtime logic pass cross-runtime fixtures.
4. **Windows host** - versioned IPC contract covers input, context, focus,
   injection, DPAPI, and process supervision with restart behavior.
5. **Pipeline and shell** - serial pipeline, history, tray, overlay, and audio
   replace the Python runtime end to end.
6. **Settings** - sections port in increasing complexity with behavior and
   screen verification after each section.
7. **Cutover** - packaged tests, beta, rollback window, Python removal, and
   production release.

Each milestone is committed only after its listed verification passes. The
Python entry points and packaging remain unchanged until milestone 7.

## Verification log

### Milestone 1 - 2026-08-02

- `npm run verify`: strict typecheck, 11 gesture tests, main/preload compile,
  and production renderer build passed.
- Real Electron smoke: compiled main process remained alive through the
  inspection window and shut down without leaving Electron processes behind.
- Built-renderer preview: expected content, theme colors, and semantic heading
  structure rendered successfully.
- `npm audit`: zero known vulnerabilities at installation.
- Python verification remains pending because the required project `.venv`
  and Python 3.11 launcher are absent from this worktree environment.

### Vertical spike checkpoint - Windows host and overlay - 2026-08-02

- The C# Windows host compiles with the installed .NET Framework compiler to a
  9.5 KB executable; no additional SDK or runtime was installed.
- Real host tests verify protocol negotiation, keyboard/mouse hook installation,
  command round-trips, graceful shutdown, and parent-pipe death handling.
- The Electron main process starts exactly one host and a forced parent exit
  leaves no Electron child or Windows-host process behind.
- The default right-Ctrl and Esc event path is wired to the TypeScript gesture
  state machine with injected-event and auto-repeat filtering.
- Offscreen captures verify neutral recording, accent-blue locked, and message
  overlay states on transparency.
- A physical/injected desktop key drive remains pending because it is an
  opt-in desktop E2E check under the project's test policy.
