# Undertone

Push-to-talk dictation. Speak in fragments, stack them into one turn, and commit
when you're ready—or paste instantly on each release.

## Install

Builds produce `Undertone-Setup-<version>-x64.exe` in `electron\release`.
Windows SmartScreen may warn about an unsigned build.

- Settings: `%APPDATA%\Undertone`
- Local engines and models: `%LOCALAPPDATA%\Undertone`

On first launch, open **Settings → Speech & AI**, choose a cloud or local
transcription provider, and save or install what it needs. Provider keys stay
on this PC and are DPAPI-encrypted on disk.

## Use

Default mode is **stack**: each push-to-talk release adds a fragment to an open
turn. Nothing is pasted until you **commit**.

| Action | Default shortcut |
|--------|------------------|
| Dictate (hold) | Left Ctrl+Left Windows |
| Commit turn | Left Ctrl+Left Alt |
| Scratch last fragment | Left Ctrl+Left Alt+Backspace |
| Discard turn | Ctrl+Alt+Shift+Backspace |
| Re-paste last commit | Left Alt+V |
| Cancel recording | Esc |

Double-tap the dictate shortcut to lock hands-free recording; tap once more to
stop. Switch to **instant** mode in Settings if you want paste-on-release.
Use the tray menu for Settings, pause, or quit.

## Settings

- **General** — shortcuts, mic, language, formatting, sounds, updates
- **Speech & AI** — STT and cleanup providers, keys, local models
- **Dictionary** — vocabulary and corrections
- **History** — session-only copy, re-paste, and retry

Changes autosave. Diagnostics: `%APPDATA%\Undertone\app.log`.

## Build from source

Requires Windows, Node.js 22.12+, npm, and the Windows C# compiler used by
`electron\scripts\build-native.ps1`.

```bat
run.bat
```

`run.bat` builds and launches from source. `build.bat` produces the NSIS
installer. For package and smoke commands, see `AGENTS.md`.

## Privacy

Audio goes only to the selected transcription provider (local keeps it on this
PC). History is in memory and discarded on exit. Pasting into elevated apps
requires Undertone itself to be elevated.
