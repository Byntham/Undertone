# Undertone

Push-to-talk dictation for Windows. Hold a global shortcut, speak, release —
Undertone transcribes the audio and pastes polished text into the text box that
had focus.

Undertone 1.4 is an Electron desktop app written in strict TypeScript, with a
small C# Windows host for global input, UI Automation, focus restoration,
DPAPI, paste injection, and supervised local-model processes. The earlier
Python/PySide6 implementation remains in the repository as a temporary rollback
path; it is no longer the primary launch or build.

## Install

Use either artifact from `electron\release`:

- `Undertone-Setup-1.4.0-x64.exe` — assisted per-user installer.
- `Undertone-1.4.0-x64-portable.exe` — self-contained portable app.

Windows SmartScreen may warn about an unsigned build. Settings remain in
`%APPDATA%\Undertone`; installed local engines and models remain in
`%LOCALAPPDATA%\Undertone`. The Electron app reuses both locations and creates
`config.json.pre-electron-backup` once before taking ownership of an existing
configuration.

On first launch, open **Settings → Providers**, choose a cloud or local
transcription provider, and save or install what it needs. Provider keys stay
write-only across the settings boundary and are DPAPI-encrypted on disk.

## Use

- Hold the push-to-talk shortcut (default **Right Ctrl**) and speak, then
  release to transcribe and paste.
- Double-tap the shortcut to lock hands-free recording; tap once more to stop.
- Press **Esc** to cancel a recording.
- Press **Ctrl+Alt+V** to re-paste the latest successful dictation.
- Use the tray menu to open Settings, pause all dictation shortcuts, or quit.

Smart formatting uses bounded caret context where Windows exposes it, then
falls back to Undertone's insertion memory. Only text before the caret may be
sent to the configured cleanup provider; text after the caret stays local and
is used only for deterministic insertion seams.

## Settings

- **General** — shortcuts, microphone, language, formatting, sound cues,
  clipboard restoration, and Start with Windows.
- **Dictionary** — vocabulary, exact corrections, and xAI-only recognition
  hints.
- **History** — session-only copy, re-paste, and retry actions.
- **Providers** — independent STT/cleanup providers, write-only cloud keys,
  local model install/load/eject controls, provider tests, model overrides, and
  local residency.
- **About** — version, settings/log locations, and developer controls.

Changes autosave. Diagnostics are written to `%APPDATA%\Undertone\app.log`.

## Build and run from source

Requirements: Windows, Node.js 22.12 or later, npm, and the Windows-provided
.NET Framework C# compiler used by `electron\scripts\build-native.ps1`.

```bat
cd electron
npm ci
npm run verify
cd ..
build.bat
```

`build.bat` produces the portable app and NSIS installer in
`electron\release`. Double-click `run.bat` to build and launch the Electron app
from source.

Useful direct commands:

```bat
cd electron
npm run verify
npm run package:dir
npm run smoke:package
npm run smoke:audio
```

## Rollback implementation

The Python reference remains available during the rollback window:

```bat
run-python.bat
build-python.bat
```

The rollback build needs PyInstaller installed once in the project venv:
`.venv\Scripts\python.exe -m pip install pyinstaller`.

It uses the same `%APPDATA%\Undertone` configuration and DPAPI key format. Do
not run the Python and Electron tray apps simultaneously; both intentionally
enforce single-instance operation and own the same global shortcuts.

## Privacy and platform notes

Audio goes only to the selected transcription provider. Local mode keeps it on
this PC. History is in-memory and is discarded on exit. Pasting into elevated
applications requires Undertone to be elevated as well because Windows blocks
lower-integrity input injection.
