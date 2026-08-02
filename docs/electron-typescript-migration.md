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
- Settings uses React; the small overlay remains plain TypeScript with
  Canvas/CSS.
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

The project `.venv` was recreated from the installed `uv` CPython 3.11.15
runtime on 2026-08-02. The routine Python suite, Settings behavior/performance
checks, live caret integration, full fake-provider desktop E2E, and focus-return
test now pass in this checkout. The environment gap recorded at migration start
is closed.

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
- [x] Audio is 16 kHz, mono, signed 16-bit PCM WAV and the existing minimum
      duration remains enforced.
- [ ] Device selection is stored and resolved by microphone name.

### Pipeline and formatting

- [x] One FIFO worker processes dictate, retry, and re-paste jobs.
- [x] Each job snapshots config when it leaves the queue.
- [x] Target HWND is captured at recording end and restored before context read
      and again after cleanup.
- [ ] UIA -> Win32 edit control -> insertion-memory fallback order is preserved.
- [ ] Password controls are never read.
- [ ] Left context may reach cleanup; right context remains local.
- [ ] Corrections, capitalization, spacing, punctuation seams, chat-period
      removal, and context-echo removal match the Python fixtures.
- [ ] Clipboard restoration and insertion memory remain generation guarded.
- [x] Any paste/refocus failure places text on the clipboard and in history.

### Providers and local engines

- [x] xAI, OpenAI, OpenRouter, and local request shapes match
      `tests/test_providers.py`.
- [x] Vocabulary biasing remains xAI-only.
- [x] Cleanup failure/timeout silently falls back to deterministic rules.
- [x] Local cleanup never blocks the current dictation on a cold model.
- [ ] Existing pinned downloads, hashes, CPU/CUDA fallback, VAD, model
      overrides, idle eject, and unified residency settings are preserved.
- [x] Local child processes die on normal exit and forced parent termination.

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
- [x] Existing local models are reused without downloading.
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
- Python verification was initially pending because this checkout lacked its
  project `.venv`; that environment gap is closed in the desktop-E2E checkpoint
  below.

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
- The native host's injected desktop drive now passes under the explicit opt-in
  gate. A complete packaged-Electron hotkey/audio/provider drive remains a
  later pipeline/cutover gate.

### Vertical spike checkpoint - audio - 2026-08-02

- A hidden, sandboxed renderer captures the microphone through an
  `AudioWorklet`; no Node or filesystem API is exposed to it.
- Resampling, chunk joining, clamping, and WAV encoding are deterministic core
  TypeScript with five unit tests.
- A local-only hardware smoke captured 506 ms and returned a 16,086-byte,
  16 kHz mono signed-16-bit PCM WAV in memory; no audio was saved or uploaded.
- Integrated startup loads the settings, overlay, and audio renderers plus one
  Windows host, and forced parent termination leaves no child process behind.

### Vertical spike checkpoint - Windows desktop services - 2026-08-02

- The versioned host protocol now exposes foreground HWND/process/title,
  bounded caret context, target focus, `SendInput` paste, DPAPI protection, and
  job-object process supervision through runtime-validated TypeScript methods.
- Routine automated checks exercise only non-disruptive paths: foreground inspection,
  a 150 ms UIA request with Win32 fallback, DPAPI round-trips and malformed
  data, and cleanup of a long-running dummy child after graceful and forced
  host termination. The opt-in desktop gate now additionally drives two WPF
  targets, restores focus, reads caret context, and pastes through `SendInput`.
- The installed .NET Framework managed UIA API exposes `TextPattern` but not
  `TextPattern2` or `LegacyIAccessiblePattern`. The spike therefore supports
  selection/caret ranges, `ValuePattern` empty checks, and classic Edit/RichEdit
  fallback now; native COM bindings for the two missing parity tiers remain
  before cutover.
- `npm run verify` passed the strict build and 20 tests at this checkpoint.
  The later desktop-E2E checkpoint records the restored Python environment.

### Vertical spike checkpoint - packaging - 2026-08-02

- Electron Builder 26.15.3 produces an unpacked x64 application, a 94.9 MB
  portable executable, and a 95.2 MB assisted per-user NSIS installer. The
  production icon and the native host are included; the host is an external
  resource rather than an executable trapped inside `app.asar`.
- The unpacked and portable artifacts pass a test-only startup path that waits
  for settings, audio, and the native host, then exits cleanly. Measured on the
  reference machine, readiness plus shutdown took about 0.5 seconds unpacked
  and 2.4 seconds through the self-extracting portable wrapper.
- Each artifact smoke uses a unique temporary Chromium profile and does not
  read or write `%APPDATA%\Undertone\config.json`. Normal preview launches use
  `%LOCALAPPDATA%\Undertone\ElectronPreview` for the same isolation.
- Inspection of the 66 KB `app.asar` confirms it contains only compiled
  JavaScript, renderer assets, source maps, and package metadata—no Python
  runtime or source. `npm audit` reports zero known vulnerabilities.
- Fresh installer, upgrade, uninstall, and code-signing checks remain cutover
  gates; building an installer is not treated as passing those stateful tests.

### Portable-core checkpoint - transcript formatting - 2026-08-02

- `textproc.py` now has a strict TypeScript counterpart covering one-pass
  dictionary correction, sentence-aware capitalization, left and right
  insertion seams, URL/email/path continuation, chat-period removal, and
  bounded insertion-memory tails.
- Eleven test groups mirror the Python assertions, including the exhaustive
  representative before/raw/after matrix and its idempotence invariant.
  Unicode property escapes preserve Python's Unicode-aware word behavior;
  symbol-bearing correction keys retain the explicit word-edge rules.
- The full Electron verification now passes 31 tests across four files. The
  parity checklist remains open until the same fixtures can be executed by
  Python and TypeScript in one verification environment.

### Portable-core checkpoint - configuration - 2026-08-02

- The full current config schema, provider-key/model lookups, and legacy model
  and unified-local-residency folds are represented in strict TypeScript.
- A main-process config store tolerates UTF-8 BOMs and corrupt/missing files,
  preserves unknown fields, encrypts only provider keys through the native
  DPAPI boundary, sorts serialized JSON, and atomically replaces `config.json`
  without mutating the in-memory snapshot.
- Temporary-directory tests cover key secrecy and round-trip behavior, legacy
  plaintext/invalid blobs, repeated atomic saves, default-container isolation,
  and the existing-directory legacy move case. The store is not yet wired to
  the preview app, so this checkpoint does not touch the production config.
- The full Electron verification now passes 39 tests across five files.

### Portable-core checkpoint - speech-to-text providers - 2026-08-02

- Typed adapters now cover xAI multipart STT, OpenAI multipart
  transcriptions, OpenRouter base64 JSON, and keyless local whisper-server
  requests with the existing default-model policy and friendly error mapping.
- Vocabulary terms are structurally limited to xAI `keyterm` fields; tests
  assert that OpenAI, OpenRouter, and local bodies contain neither prompts nor
  vocabulary fields. Local output retains newline/whitespace collapsing.
- The shared fetch adapter bounds both response headers and body consumption,
  rather than clearing its timeout as soon as headers arrive.
- Six mocked, keyless tests bring full Electron verification to 45 tests across
  six files. No provider request was sent over the network.

### Pipeline-core checkpoint - text preparation and insertion memory - 2026-08-02

- The cleanup/deterministic formatting junction now has a dependency-injected
  TypeScript boundary: cleanup sees corrected transcript plus left context,
  app identity, and dictionary, while right context stays exclusively in the
  local finalization pass.
- Cleanup misses fall back to deterministic formatting, disabled smart
  formatting never queries the caret, and chat-period removal preserves the
  right seam exactly as the Python pipeline does.
- Generation-guarded insertion memory records the paste-start token, supplies
  only left context, honors explicit empty native context, and rejects changed
  windows, user input races, and entries at the five-minute boundary.
- Eight tests mirroring `test_pipeline.py` bring full Electron verification to
  53 tests across seven files.

### Portable-core checkpoint - AI cleanup - 2026-08-02

- All cloud cleanup endpoints and the keyless llama-server dialect now use the
  exact structured-output schema, defaults, override fields, and quoted user
  payload from `cleanup.py` through the bounded shared HTTP adapter.
- The benchmarked system prompt was mechanically copied rather than rewritten;
  a migration-only test extracts the Python literal and requires exact string
  equality (with source line endings normalized as Python's parser does).
- Cold local cleanup starts background warming and skips the current dictation.
  Unknown providers, HTTP/non-JSON/schema failures, exceptions, and timeouts all
  return `null` for deterministic fallback.
- Context-echo removal retains whole-word boundary guards and the reply-length
  sanity check. Six tests bring full Electron verification to 59 tests across
  eight files.

### Pipeline-core checkpoint - serialization and history - 2026-08-02

- A concrete dictate/retry/re-paste queue now drains one job at a time in FIFO
  order. It clones mutable audio/target inputs and takes a deep-enough config
  snapshot only when each job leaves the queue; a rejected job cannot stall
  later work.
- Session history is bounded, returns newest-first copies, locates the latest
  successful paste, consumes a retry exactly once, and retains WAV data for
  only the three newest failures.
- Six concurrency/history tests bring full Electron verification to 65 tests
  across nine files.

### Pipeline-core checkpoint - paste safety and job runner - 2026-08-02

- The clipboard boundary writes text, waits for propagation, invokes the native
  paste operation, and conditionally restores prior content after 500 ms. A
  generation token cancels stale restores, and an additional value check avoids
  overwriting something the user copied during that window.
- The dictation runner composes vocabulary, transcribes, restores the target
  before local context and again after cleanup, prepares text, pastes, updates
  history/insertion memory, and emits outcome feedback. Refocus or injection
  failure copies final text to the clipboard and history without updating
  phantom insertion memory; transcription failure retains WAV retry data.
- Input racing the 150 ms clipboard propagation delay leaves insertion memory
  invalid through the paste-start generation token. Eleven tests bring full
  Electron verification to 76 tests across eleven files.
- These components are not yet wired to the preview shell, so the corresponding
  end-to-end parity boxes remain open despite their isolated coverage.

### Pipeline/shell checkpoint - cloud path integration - 2026-08-02

- The Electron preview now loads a preview-isolated config through the native
  DPAPI service before enabling input, then sends completed WAV captures into
  the FIFO dictation queue. The release-time target HWND/executable flows
  through pre-context and post-cleanup restoration into native paste.
- Genuine non-hotkey keyboard events and mouse clicks invalidate insertion
  memory. Short captures are rejected at the existing 9,600-byte threshold;
  pipeline, transcription, no-speech, fallback, and paste outcomes all reach
  the overlay rather than disappearing silently.
- Cloud STT and cleanup are fully composed with formatting, Electron clipboard,
  history, and the native host. Preview config remains under
  `%LOCALAPPDATA%\Undertone\ElectronPreview`; production config is untouched.
  Local provider selection fails safely until local lifecycle migration lands.
- The rebuilt unpacked package passes its isolated service/config smoke, and a
  fresh hardware audio smoke returned a 502 ms, 15,746-byte valid WAV. Physical
  full packaged-Electron hotkey/audio/provider drive remains pending. Native
  focus/paste and the Python reference's full fake-provider drive now pass their
  explicit desktop gates.

### Shell checkpoint - tray-owned lifecycle - 2026-08-02

- The preview now retains a real `Tray`, uses packaged production icon assets,
  opens Settings on demand/second instance, hides rather than exits when
  Settings closes, and exposes Pause dictation plus Quit actions. Pause/resume
  stops and restarts native input capture and cancels an active gesture.
- The packaged smoke requires tray creation and programmatically closes the
  Settings window, failing unless the tray-owned app and window survive. It
  then verifies normal shutdown and native-host cleanup as before.
- Red recording icon state, complete tooltip/menu parity, capture-aware pause,
  and long-running no-window behavior remain before the tray parity box can be
  closed.

### Settings checkpoint - React shell and General section - 2026-08-02

- The placeholder renderer is now a React 19.2 settings shell with General and
  About navigation. The first autosaving fields cover language, smart
  formatting, AI cleanup, and clipboard restoration; the fixed right-Ctrl
  shortcut is deliberately read-only until shortcut capture is ported.
- The preload exposes only a renderer-safe settings DTO. Provider keys and the
  native/config services stay in the main process; sender authorization,
  patch whitelisting, value validation, and a serialized atomic-save chain
  guard all renderer updates.
- The production renderer passed a screen-based check at 960 x 720 with no
  horizontal overflow. General/About navigation and switch state updates were
  exercised in the collaborative browser. This also confirmed that the strict
  CSP correctly loads the production external stylesheet; Vite's inline
  development CSS is intentionally rejected by that policy.
- `npm run verify` passes the strict build and 79 tests across 12 files. The
  rebuilt unpacked package passes the isolated tray/config/native-host smoke.
  Remaining settings sections, shortcut capture, DPI checks, and full behavior
  parity stay open.

### Settings checkpoint - cloud providers - 2026-08-02

- Providers now exposes independent speech-to-text and cleanup selection for
  xAI, OpenAI, and OpenRouter, plus provider-specific model overrides. Local is
  visible but disabled for new selections until its download/server/residency
  lifecycle is migrated, so the UI does not advertise a broken path.
- API-key updates are write-only across the preload boundary. The renderer sees
  one configured/not-configured bit per cloud provider, while the main process
  validates an exact patch shape, maps the value to the existing key field, and
  delegates DPAPI encryption plus atomic replacement to `ConfigStore`.
- The production renderer passed top and scrolled screen checks at 960 x 720,
  provider/key/model interaction checks, and a secret non-echo assertion. The
  page remains free of horizontal overflow and labels the unavailable local
  option explicitly.
- `npm run verify` passes the strict build and 82 tests across 12 files. The
  rebuilt unpacked package passes isolated lifecycle smoke; no network provider
  request or production-config write was performed.

### Desktop-E2E checkpoint - Python reference and Windows host - 2026-08-02

- A fresh project `.venv` on CPython 3.11.15 passes syntax compilation, the
  routine Python formatting/pipeline/gesture/provider/local-engine/caret suite,
  Settings behavior checks, and every Settings resize gate (3.2-4.8 ms median
  against the 18 ms limit).
- The live caret test caught a classification defect: an empty Value/Legacy
  pattern on the Windows desktop was being treated as an empty editor. Direct
  empty evidence is now accepted only from UIA Edit and Document controls;
  unit coverage and the WPF text/password, WinForms empty-field, desktop, and
  bounded-timeout live cases all pass.
- The Python full desktop E2E passes sentence start, middle insertion with both
  caret seams, and insertion-memory fallback using real F13 hook/record/paste
  wiring with fake transcription. Its middle-insertion setup now verifies the
  caret explicitly instead of relying on WPF's inconsistent single
  `Ctrl+Left` behavior. The separate focus-return scenario also passes.
- A new opt-in Electron native-host desktop test drives two disposable WPF
  editors, moves foreground to a thief window, restores the original HWND,
  reads `I like |apples.`, and pastes through `SendInput`. It exposed and fixed
  two native defects: the marshalled `INPUT` union lacked `MOUSEINPUT`'s x64
  size, and focus queue attachments were released before Windows completed the
  foreground transition. The corrected gate passed four consecutive runs.

### Local-runtime checkpoint - installed engine reuse - 2026-08-02

- The Electron pipeline now uses TypeScript-managed whisper.cpp and llama.cpp
  runtimes instead of unavailable-local stubs. Both reuse the authoritative
  `%LOCALAPPDATA%\Undertone` runtime/model/state layout, prefer the installed
  CUDA build, persist CUDA disablement before CPU fallback, use randomized
  loopback ports, and run as native-host-supervised children.
- Local STT block-loads when a dictation arrives cold. Local cleanup preserves
  the non-blocking contract: the current dictation falls back immediately and
  single-flight warming prepares the next one. Both share startup residency,
  idle auto-eject, explicit Load/Eject, filename-confined model overrides, and
  graceful shutdown before the host job object closes.
- The native supervisor now reports process liveness and redirects child output
  to the existing `server.log` / `llm-server.log` files, preventing engine text
  from corrupting the JSON protocol pipe. Unit tests cover reuse/eject, dead
  process recovery, CUDA fallback state, warming concurrency, and argument/path
  safety.
- The real installed CUDA whisper server passed a VAD-backed silent-WAV request
  with an empty transcript, and the real CUDA llama server returned valid
  structured cleanup. Both live gates exited without residual server or host
  processes. The freshly unpacked Electron package passes both its normal smoke
  and `PACKAGED_LOCAL_RUNTIME_SMOKE_OK`.
- Providers now shows installed/loaded/loading/build state, enables Local only
  when that engine exists, and exposes Load/Eject plus unified startup and idle
  controls. Production-renderer checks at 960 x 720 cover the Local selectors,
  CUDA status transition, autosave controls, scrolling, and no horizontal
  overflow. Pinned download/extraction/progress UI remains before the combined
  local-engine parity box can close.
