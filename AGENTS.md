# Undertone development guide

Undertone is a Windows-only push-to-talk dictation tray app. Hold a global
shortcut, speak, and release; Undertone transcribes the recording and pastes
formatted text into the focused control.

The product is Electron + strict TypeScript. A small C# process owns Windows
hooks, UI Automation, focus restoration, SendInput, DPAPI, archive extraction,
and child-process job objects. Do not introduce another application runtime.

## Commands

Run commands from `electron\` unless noted otherwise:

```bat
npm ci
npm run verify
npm run smoke:audio
npm run package
npm run smoke:package
npm run smoke:package:local
```

From the repository root, `run.bat` builds and launches the source app and
`build.bat` creates the NSIS and portable artifacts in `electron\release`.

Opt-in tests:

- `UNDERTONE_HOST_DESKTOP_E2E=1` enables the focus/caret/password/paste drive.
- `UNDERTONE_LOCAL_RUNTIME_E2E=1` exercises installed local engines.
- `UNDERTONE_LOCAL_INSTALLER_E2E=1` downloads and verifies pinned artifacts.

The desktop test steals focus and is valid only while the desktop is idle.

## Release rules

- `electron/package.json`, its lockfile, and the renderer preview version must
  stay in sync.
- Use a minor version for a feature batch and a patch version for a fix-only
  release.
- `npm run package` builds x64 NSIS and portable artifacts. They are unsigned
  unless a release certificate is supplied externally.
- Never commit `electron/node_modules`, `electron/dist`, `electron/release`,
  test output, user configuration, API keys, models, or runtime downloads.

## Architecture

Data flow:

```text
C# Windows host -> Electron main FIFO pipeline -> provider/local engine
       ^                     |                         |
global input/caret       history/config          transcript/cleanup
                             |
                 clipboard + focus-safe paste
```

Renderer processes are sandboxed and context-isolated. Preloads expose only
task-specific typed APIs; provider keys, filesystem access, generic IPC, and
native handles stay in the main process.

The main process owns one ordered dictation queue. Each job snapshots config at
dequeue. Clipboard restoration, insertion memory, history, target restoration,
turn-buffer commit/scratch/discard, and paste sequencing assume this
single-writer design.

Stack dictation mode owns an in-memory open turn: PTT releases append fragments;
formatting uses the buffer tail; paste happens only on explicit commit. Instant
mode keeps paste-per-release. See `docs/handoff/session-turn-buffer.md` for
intent, architecture, and handoff context (major product direction).

All native-host messages are versioned JSON over local pipes. Keep Windows API
work in the host rather than expanding renderer or main-process privileges.

## Product invariants

- Password fields are never read. Instant-mode context order is UI Automation,
  Win32 edit, then insertion memory. Stack mode formats against the open turn
  buffer and does not require caret reads.
- Only left-side context may reach AI cleanup (caret before, or buffer tail in
  stack mode). Right-side context remains local and is used only for
  deterministic formatting seams.
- Vocabulary hints are xAI-only. Do not send prompt-style vocabulary to other
  speech providers.
- Local cleanup never blocks the current dictation while a cold model loads;
  it warms asynchronously and that dictation uses deterministic fallback.
- Local STT may load synchronously because transcription requires it.
- Local engine downloads remain version-, size-, and SHA-256-pinned. Continue
  using `%LOCALAPPDATA%\Undertone` so installed models are reused.
- Configuration remains `%APPDATA%\Undertone\config.json`, saves atomically,
  and encrypts provider keys with user-bound DPAPI.
- The overlay never accepts focus or pointer input. Text is pre-rendered to an
  alpha image to avoid ClearType fringes on transparency.
- Every outcome reaches the overlay: recording, locked, transcribing, slow,
  success, warning, cancellation, or error.
- Local child processes must die on normal shutdown and forced parent exit.

## Verification

Run `npm run verify` after code changes. For release or Windows-host changes,
also run the applicable opt-in tests and packaged smokes. UI changes require
screen captures using `scripts/capture-settings.cjs` and/or
`scripts/capture-overlay.cjs`; check 100%, 150%, and 200% scaling and verify no
horizontal overflow.

Keep changes surgical, preserve unrelated user work, and never push unless the
user explicitly asks.
