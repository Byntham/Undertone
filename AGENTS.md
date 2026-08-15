# Undertone development guide

Undertone is a push-to-talk dictation tray app. Holding and releasing the
dictate shortcut auto-commits; tapping it toggles recording and the next tap
auto-commits. Left Alt during either form stops and appends to an in-memory open
turn instead. Electron + strict TypeScript own the app. A small native host owns
OS input hooks, focus validation, paste injection, secret
protection, archive extraction, and child-process supervision. Today's host is
C# on Windows; keep OS-specific work in that host layer. Do not introduce
another application runtime.

## Commands

Run from `electron\` unless noted:

```bat
npm ci
npm run verify
npm run smoke:audio
npm run package
npm run smoke:package
npm run smoke:package:local
```

Root: `run.bat` launches from source; `build.bat` writes the NSIS installer to
`electron\release`.

Opt-in tests (idle desktop only; they steal focus or the mouse):

- `UNDERTONE_HOST_DESKTOP_E2E=1` — focus identity and guarded paste
- `UNDERTONE_LOCAL_RUNTIME_E2E=1` — installed local engines
- `UNDERTONE_LOCAL_INSTALLER_E2E=1` — pinned download artifacts
- `npm run test:turn-draft-native` — open-turn draft window interactions

## Release

- Keep `electron/package.json` and its lockfile in sync.
- `npm run package` builds an x64 NSIS installer (unsigned unless a cert is
  supplied externally).
- Never commit `electron/node_modules`, `electron/dist`, `electron/release`,
  test output, user config, API keys, models, or runtime downloads.

## Architecture

```text
Native host -> Electron main FIFO pipeline -> provider/local engine
      ^                    |                         |
 OS input/focus       history/config          transcript/cleanup
                             |
                 clipboard + focus-safe paste
```

Sandboxed, context-isolated renderers; preloads expose only task-specific typed
APIs. Secrets, filesystem, and native handles stay in main.

One ordered dictation queue owns transcription, cleanup, paste, history, and
turn commit/scratch/discard. Jobs snapshot config at dequeue and carry a
completion intent: `commit` or `open-turn`.

Every completed recording first appends to the in-memory turn. Normal completion
then cleans and commits the whole turn; Left Alt leaves it open. Cleanup uses
buffer text only (no caret). `stack_cleanup_strategy` is `live-full` (default)
or `commit-full`, fixed for the open turn. External typing does not clear the
turn. Clear on commit success, discard, or quit; transcription, focus, or paste
failure keeps it. Manual commit pastes into current focus. Auto-commit captures
the foreground target at completion and validates it again immediately before
native paste injection; it never steals focus.

Native-host messages are versioned JSON over local pipes.

## Product invariants

- Never read password fields. Dictation cleanup formats from the open turn only.
- No OS text context may reach AI cleanup; the raw open turn is the only context.
- Local cleanup never blocks a dictation on cold load (async warm + deterministic
  fallback). Local STT may load synchronously.
- Local engine downloads stay version-, size-, and SHA-256-pinned under
  `%LOCALAPPDATA%\Undertone`.
- Config is `%APPDATA%\Undertone\config.json`, atomic saves, DPAPI for keys.
- Status overlay: no focus, no pointer input. Open-turn draft: pointer for
  drag/resize/snap/discard only, never focus. Overlay status text is a
  pre-rendered alpha image.
- Every outcome reaches the overlay (recording, locked, transcribing, slow,
  success, warning, cancellation, error).
- Local child processes die on normal shutdown and forced parent exit.

## Verification

Run `npm run verify` after code changes. For release or native-host changes,
also run applicable opt-in tests and package smokes. UI changes: capture with
`scripts/capture-settings.cjs` and/or `scripts/capture-overlay.cjs` at 100%,
150%, and 200% scaling; no horizontal overflow.
