# Undertone

Push-to-talk dictation for Windows. Hold a global shortcut, speak, and release;
Undertone transcribes the audio and pastes polished text into the text box that
had focus.

Undertone 1.6 is an Electron desktop app written in strict TypeScript, with a
small C# Windows host for global input, UI Automation, focus restoration,
DPAPI, paste injection, and supervised local-model processes.

## Install

Builds produce the installer in `electron\release`:

- `Undertone-Setup-1.8.0-x64.exe` - assisted per-user installer with in-app updates.

Windows SmartScreen may warn about an unsigned build. Settings are stored in
`%APPDATA%\Undertone`; installed local engines and models are stored in
`%LOCALAPPDATA%\Undertone`.

On first launch, open **Settings -> Speech & AI**, choose a cloud or local
transcription provider, and save or install what it needs. Provider keys stay
write-only across the settings boundary and are DPAPI-encrypted on disk.

## Use

- Hold the push-to-talk shortcut (default **Left Ctrl+Left Windows**) and speak, then
  release to transcribe and paste.
- Double-tap the shortcut to lock hands-free recording; tap once more to stop.
- Press **Esc** to cancel a recording.
- Press **Left Alt+V** to re-paste the latest successful dictation.
- Use the tray menu to open Settings, pause dictation, or quit.

Smart formatting uses bounded caret context where Windows exposes it, then
falls back to Undertone's insertion memory. Only text before the caret may be
sent to the configured cleanup provider; text after the caret stays local and
is used only for deterministic insertion seams.

## Settings

- **General** - shortcuts, microphone test, language, formatting, sound cues,
  clipboard restoration, Start with Windows, automatic updates, version, and
  diagnostic paths.
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

`build.bat` produces the NSIS installer. `run.bat` builds and launches Undertone
from source. Installed builds check the public GitHub
Releases channel after launch and can download, restart, and install updates
from **Settings -> General**. The desktop shortcut is recreated during upgrades.

Useful direct commands:

```bat
cd electron
npm run verify
npm run package:dir
npm run smoke:package
npm run smoke:package:local
npm run smoke:audio
```

## Development worktrees

Installed Undertone can supervise development builds without running a launcher
from each worktree. Right-click the tray icon and open **Development**. Undertone
automatically discovers T3 Code's Undertone worktrees and lists them by readable
branch name. Choose one to enable development and build it. **Choose repository
folder…** is available only as a fallback when automatic discovery is unavailable.

Selecting a worktree builds it into `%LOCALAPPDATA%\Undertone\DevBuilds` while
production remains active. After a successful build, the controller releases
input handling and starts the selected build without a second tray icon. Use
**Rebuild active worktree** after source changes, or select **Production** to
return. If the development process fails, production input is restored.

Development uses `%LOCALAPPDATA%\Undertone\ManagedDev` for configuration. The
production configuration is copied there only when the development profile is
first created. Local engines and models remain shared.

Worktrees must contain the current `undertoneDevProtocol` package marker. Update
older branches from `main` when the menu marks them incompatible. To test several
features together, maintain a `dev/integration` worktree and merge checkpoint
commits from the selected feature branches into it; uncommitted changes remain
local to their individual worktrees.

## Privacy and platform notes

Audio goes only to the selected transcription provider. Local mode keeps it on
this PC. History is held in memory and discarded on exit. Pasting into elevated
applications requires Undertone to be elevated because Windows blocks
lower-integrity input injection.
