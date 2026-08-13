# Undertone

Push-to-talk dictation with live or batch transcription, automatic paste, and
an open turn for composing multiple fragments.

## Install

Builds produce `Undertone-Setup-<version>-x64.exe` in `electron\release`.
Windows SmartScreen may warn about an unsigned build.

- Settings: `%APPDATA%\Undertone`
- Local engines and models: `%LOCALAPPDATA%\Undertone`

On first launch, open **Settings → Speech & AI**, choose a cloud or local
transcription provider, and save or install what it needs. Provider keys stay
on this PC and are DPAPI-encrypted on disk.

## Use

Hold the dictate shortcut and release it to transcribe, clean up, and paste.
Tap it once for hands-free recording, then tap it again to finish and paste.
Press **Left Alt** while recording to stop without pasting and append the result
to the open turn instead.

| Action | Default shortcut |
|--------|------------------|
| Dictate (hold or tap) | Left Ctrl+Left Windows |
| Keep recording in open turn | Left Alt while recording |
| Commit open turn | Left Ctrl+Left Alt |
| Scratch last fragment | Left Ctrl+Left Alt+Backspace |
| Discard open turn | Ctrl+Alt+Shift+Backspace |
| Re-paste last commit | Left Alt+V |
| Cancel recording | Esc |

A held release or second toggle tap captures the current paste target. If focus
changes before injection, Undertone keeps the turn open for manual commit.
Use the tray menu for Settings, pause, or quit.

## Settings

- **General** — shortcuts, mic, language, sounds, updates
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

### Experimental Nemotron streaming

Undertone can use NVIDIA Nemotron Streaming 0.6B as one local model for both
live preview and the completed transcript. The experimental Windows runtime is
not part of the normal installer yet. After installing CMake, Ninja, Visual
Studio 2022 Build Tools, and the CUDA Toolkit, run:

```powershell
./electron/scripts/setup-nemotron-experimental.ps1
```

The script downloads and verifies the pinned model first, then builds a pinned
NeMo-Speech.cpp revision. Downloads resume after a connection interruption.
Restart Undertone after the first setup so it inherits CUDA's system path, then
choose **Nemotron Streaming 0.6B** under **Settings → Speech & AI → Local
transcription engine**. Whisper and Nemotron are never loaded as transcription
engines at the same time. Local live preview is Nemotron-only; Whisper Large V3
Turbo remains available for completed, non-live recordings.

## Privacy

Audio goes only to the selected transcription provider (local keeps it on this
PC). History is in memory and discarded on exit. Pasting into elevated apps
requires Undertone itself to be elevated.
