# Undertone

Push-to-talk dictation for Windows. Hold a key, speak, release — your words
are transcribed by your choice of provider (xAI, OpenAI, or OpenRouter) and
pasted into whatever text box has focus.

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

The Undertone icon appears in the system tray. Open **Settings →
Providers**, pick your transcription and AI-cleanup providers, paste the
matching API key ([console.x.ai](https://console.x.ai),
[platform.openai.com](https://platform.openai.com), or
[openrouter.ai](https://openrouter.ai)), and use the Test buttons to verify.

## Use

- **Hold** the push-to-talk shortcut (default: **right Ctrl**) and speak —
  a pill at the bottom of the screen shows live microphone bars.
- **Release**. After a brief spinner, the text is pasted into the focused
  text box.
- **Double-tap** the shortcut to lock hands-free recording for longer
  dictation; tap once more to finish. Very short taps are ignored.
- **Ctrl+Alt+V** re-pastes your latest dictation (for when it landed in the
  wrong window).

## Smart formatting and AI cleanup

Undertone adapts each dictation to where your cursor is: it inserts a space
when you continue after existing text, lowercases a sentence-case opener
when you're mid-sentence, and capitalizes at a sentence start. Context comes
from the focused control where Windows exposes it (UI Automation, or the
classic Win32 edit-control protocol), falling back to what Undertone itself
last pasted. In chat apps (Slack, Discord, WhatsApp…) a lone trailing
period on a short message is dropped.

With **AI cleanup** on, a fast chat model additionally removes filler words
and false starts ("we should… actually let's just…" keeps only the
correction), fixes mishearings using your dictionary, and fits the phrasing
to the surrounding text — adding roughly half a second before the paste.
The mechanical seam (leading space, sentence-start capital) always stays
rule-based, and any model failure or timeout falls back silently to the
rule-based result. Note: with AI cleanup on, the ~300 characters before
your cursor are sent to the cleanup provider along with the audio. Both
toggles live in **Settings → General**.

## Settings (tray icon → Settings…)

- **General** — change the push-to-talk and re-paste shortcuts (click
  *Change*, then press any key or combination, e.g. `ctrl+shift+space`;
  Esc cancels), pick the spoken language, and toggle *Start with
  Windows*, *Smart formatting*, *AI cleanup*, and *Sound cues*.
- **Dictionary** — *Vocabulary*: names and jargon the transcriber should
  recognize (sent as recognition hints with every request). *Corrections*:
  always replace a misheard phrase with the right one.
- **History** — this session's dictations, with copy and re-paste. History
  lives in memory only and is gone when the app exits.
- **Providers** — choose the transcription and AI-cleanup providers
  independently (any mix of xAI, OpenAI, OpenRouter), save and test each
  key, and override model IDs under *Advanced* (empty = a sensible
  per-provider default). Keys are stored locally in
  `%APPDATA%\Undertone\config.json`; keep that file private.
- Changes apply immediately — there is no Save button to forget.

An optional dedicated toggle-mode key can be set in `config.json`
(`toggle_hotkey`).

## Privacy

Audio goes to your chosen transcription provider and nowhere else.
Undertone never captures your screen, keeps no audio, and its dictation
history is in-memory only.

## Notes

- Only one instance runs at a time; launching a second shows a notice.
- Diagnostics are logged to `%APPDATA%\Undertone\app.log`.
- Pasting into apps running **as Administrator** requires this app to be
  elevated too (Windows blocks synthetic input across integrity levels).
- `transcriber.py`'s PROVIDERS registry is the extension point for
  additional STT providers.
