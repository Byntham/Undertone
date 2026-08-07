# Undertone development guide

Undertone is a push-to-talk dictation tray app. Default **stack** mode appends
each release to an in-memory open turn and pastes only on commit; **instant**
mode pastes per release. Electron + strict TypeScript own the app. A small
native host owns OS input hooks, focus restoration, paste injection, secret
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

- `UNDERTONE_HOST_DESKTOP_E2E=1` — focus/caret/password/paste
- `UNDERTONE_LOCAL_RUNTIME_E2E=1` — installed local engines
- `UNDERTONE_LOCAL_INSTALLER_E2E=1` — pinned download artifacts
- `npm run test:turn-draft-native` — open-turn draft window interactions

## Release

- Keep `electron/package.json`, its lockfile, and the renderer preview version
  in sync.
- `npm run package` builds an x64 NSIS installer (unsigned unless a cert is
  supplied externally).
- Never commit `electron/node_modules`, `electron/dist`, `electron/release`,
  test output, user config, API keys, models, or runtime downloads.

## Architecture

```text
Native host -> Electron main FIFO pipeline -> provider/local engine
      ^                    |                         |
 OS input/caret       history/config          transcript/cleanup
                             |
                 clipboard + focus-safe paste
```

Sandboxed, context-isolated renderers; preloads expose only task-specific typed
APIs. Secrets, filesystem, and native handles stay in main.

One ordered dictation queue owns paste, history, insertion memory, turn
commit/scratch/discard, and mode transitions. Jobs snapshot config at dequeue.

Stack mode: fragments append to one open turn; cleanup uses buffer text only
(no caret). `stack_cleanup_strategy` is `live-full` (default) or `commit-full`,
fixed for the open turn. The turn is memory-only; external typing does not clear
it. Clear on commit success, discard, stack→instant, or quit; paste failure
keeps the turn. Commit pastes into the current focus. Instant mode keeps
paste-per-release with caret/insertion context.

Native-host messages are versioned JSON over local pipes.

## Product invariants

- Never read password fields. Instant context order: UIA → Win32 edit →
  insertion memory. Stack formats from the open turn only.
- Only left-side context may reach AI cleanup (instant: caret-before; stack:
  raw turn, no OS context). Right-side text is local, for seams only.
- Vocabulary hints are xAI-only.
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
