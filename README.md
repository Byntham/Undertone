# Undertone

Push-to-talk dictation for Windows. Hold a key, speak, release — your words are transcribed via the
[xAI Speech-to-Text API](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text)
and pasted into whatever text box has focus.

## Setup

```
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
```

## Run

Double-click `run.bat`, or:

```
.venv\Scripts\python main.py
```

The Undertone icon appears in the system tray. Open **Settings → API Key**,
paste your key from [console.x.ai](https://console.x.ai), click **Save key**
(use **Test key** to verify it), and you're ready.

## Use

- **Hold** the push-to-talk shortcut (default: **right Ctrl**) and speak —
  a pill at the bottom of the screen shows live microphone bars.
- **Release**. After a brief spinner, the text is pasted into the focused
  text box.
- **Double-tap** the shortcut to lock hands-free recording for longer
  dictation; tap once more to finish. Very short taps are ignored.
- **Ctrl+Alt+V** re-pastes your latest dictation (for when it landed in the
  wrong window). **Ctrl+Alt+F** opens a small box to fix the last
  dictation — the corrected text is pasted, and repeated fixes are learned
  as automatic corrections.

## Smart formatting

Undertone adapts each dictation to where your cursor is: it inserts a space
when you continue after existing text, lowercases a sentence-case opener
when you're mid-sentence, and capitalizes at a sentence start. Context comes
from the focused control where Windows exposes it, falling back to what
Undertone itself last pasted. In chat apps (Slack, Discord, WhatsApp…) a
lone trailing period on a short message is dropped. Toggle it all in
**Settings → General**.

## Settings (tray icon → Settings…)

- **General** — change the shortcut (click *Change*, then press any key or
  combination, e.g. `ctrl+shift+space`; Esc cancels), pick the spoken
  language, and toggle *Start with Windows*, *Smart formatting*, and
  *Sound cues*.
- **Dictionary** — *Vocabulary*: names and jargon the transcriber should
  recognize (sent as recognition hints with every request). *Corrections*:
  always replace a misheard phrase with the right one; entries are also
  added automatically when the same fix is made twice via **Ctrl+Alt+F**.
- **History** — this session's dictations, with copy and re-paste. History
  lives in memory only and is gone when the app exits.
- **API Key** — save and test your xAI key. It is stored locally in
  `%APPDATA%\Undertone\config.json`; keep that file private.
- Changes apply immediately — there is no Save button to forget.

The re-paste/fix hotkeys and an optional dedicated toggle-mode key can be
changed in `config.json` (`repaste_hotkey`, `fix_hotkey`, `toggle_hotkey`).

## Privacy

Audio goes to the xAI API for transcription and nowhere else. Undertone
never captures your screen, keeps no audio, and its dictation history is
in-memory only.

## Notes

- Only one instance runs at a time; launching a second shows a notice.
- Diagnostics are logged to `%APPDATA%\Undertone\app.log`.
- Pasting into apps running **as Administrator** requires this app to be
  elevated too (Windows blocks synthetic input across integrity levels).
- `transcriber.py` is structured so other STT providers can be added later.
