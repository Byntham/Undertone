# Undertone

Push-to-talk dictation for Windows. Hold a key, speak, release — your words are transcribed via the
[xAI Speech-to-Text API](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text)
and pasted into whatever text box has focus.

## Setup

```
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
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
- **Release**. After a brief "Transcribing…" spinner, the text is pasted
  into the focused text box and a preview flashes in the pill.
- Very short taps (under ~0.3 s) are ignored.

## Settings (tray icon → Settings…)

- **General** — change the shortcut (click *Change*, then press any key or
  combination, e.g. `ctrl+shift+space`; Esc cancels), pick the spoken
  language from the dropdown, and toggle *Start with Windows*.
- **API Key** — save and test your xAI key. It is stored locally in
  `%APPDATA%\Undertone\config.json`; keep that file private.
- Changes apply immediately — there is no Save button to forget.

## Notes

- Only one instance runs at a time; launching a second shows a notice.
- Diagnostics are logged to `%APPDATA%\Undertone\app.log`.
- Pasting into apps running **as Administrator** requires this app to be
  elevated too (Windows blocks synthetic input across integrity levels).
- `transcriber.py` is structured so other STT providers can be added later.
