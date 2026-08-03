# Undertone

Push-to-talk dictation for Windows. Hold a global shortcut, speak, and release;
Undertone transcribes the audio and pastes polished text into the text box that
had focus.

Undertone 1.5 is an Electron desktop app written in strict TypeScript, with a
small C# Windows host for global input, UI Automation, focus restoration,
DPAPI, paste injection, and supervised local-model processes.

## Install

Builds produce two artifacts in `electron\release`:

- `Undertone-Setup-1.5.0-x64.exe` - assisted per-user installer.
- `Undertone-1.5.0-x64-portable.exe` - self-contained portable app.

Windows SmartScreen may warn about an unsigned build. Settings are stored in
`%APPDATA%\Undertone`; installed local engines and models are stored in
`%LOCALAPPDATA%\Undertone`.

On first launch, open **Settings -> Speech & AI**, choose a cloud or local
transcription provider, and save or install what it needs. Provider keys stay
write-only across the settings boundary and are DPAPI-encrypted on disk.

## Use

- Hold the push-to-talk shortcut (default **Right Ctrl**) and speak, then
  release to transcribe and paste.
- Double-tap the shortcut to lock hands-free recording; tap once more to stop.
- Press **Esc** to cancel a recording.
- Press **Ctrl+Alt+V** to re-paste the latest successful dictation.
- Use the tray menu to open Settings, pause dictation, or quit.

Smart formatting uses bounded caret context where Windows exposes it, then
falls back to Undertone's insertion memory. Only text before the caret may be
sent to the configured cleanup provider; text after the caret stays local and
is used only for deterministic insertion seams.

## Settings

- **General** - shortcuts, microphone test, language, formatting, sound cues,
  clipboard restoration, Start with Windows, version, and diagnostic paths.
- **Speech & AI** - independent STT/cleanup providers, write-only cloud keys,
  local model install/load/eject controls, provider tests, model overrides, and
  advanced local residency and cleanup controls.
- **Dictionary** - vocabulary, exact corrections, and contextual xAI-only
  recognition hints.
- **History** - session-only copy, re-paste, and retry actions.

Changes autosave. Diagnostics are written to `%APPDATA%\Undertone\app.log`.

## Build and run

Requirements: Windows, Node.js 22.12 or later, npm, and the Windows-provided
.NET Framework C# compiler used by `electron\scripts\build-native.ps1`.

```bat
cd electron
npm ci
npm run verify
cd ..
build.bat
```

`build.bat` produces the portable app and NSIS installer. `run.bat` builds and
launches Undertone from source.

Useful direct commands:

```bat
cd electron
npm run verify
npm run package:dir
npm run smoke:package
npm run smoke:package:local
npm run smoke:audio
```

## Privacy and platform notes

Audio goes only to the selected transcription provider. Local mode keeps it on
this PC. History is held in memory and discarded on exit. Pasting into elevated
applications requires Undertone to be elevated because Windows blocks
lower-integrity input injection.
