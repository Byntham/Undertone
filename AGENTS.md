# AGENTS.md

Behavioral guidelines; Merge with project-specific instructions as needed.

**Tradeoff:** These are default guidelines but use your judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

# Project: Undertone

Windows-only push-to-talk dictation tray app: hold a global hotkey, speak, release — audio is transcribed via API and pasted into the focused text box. Python 3.11 + PySide6 (Qt), no build step.

## Commands

```
.venv\Scripts\python.exe main.py                        # run with console (see tracebacks)
run.bat                                                  # run detached via pythonw (how users launch it)
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m py_compile *.py              # syntax check (no linter configured)
```

- Always use the project venv; the `python` on PATH belongs to an unrelated tool's venv. Prefer `python -m pip` over `pip.exe`.
- Smoke test: launch via pythonw, wait a few seconds, read `%APPDATA%\Undertone\app.log`, kill the process. A silent instant exit with an empty log usually means another instance holds the `Undertone_SingleInstance` mutex — check for running `pythonw` first.
- UI verification: instantiate `settingsui.SettingsWindow` / `overlay.Overlay` on a `QApplication` (set `app.setStyle("Fusion")` — main.py does) with fake callbacks/`level_getter`, drive their show methods with `QTimer` steps, and capture via `widget.grab()` (settings) or a screen grab of the pill's rect (the overlay is translucent; grab the composited screen region). Ready-made harnesses live in `spikes/qt_settings_capture.py`, `spikes/qt_overlay_capture.py`, `spikes/qt_settings_behavior.py`. Prefer delegating capture+judgment to the `ui-verifier` agent (`.claude/agents/ui-verifier.md`) — the main session should consume verdicts, not screenshots.
- Tests live in `tests/` (plain assert scripts, no pytest): `test_textproc.py`, `test_gestures.py`, `test_providers.py` (mocked, keyless), `test_localstt.py`, `test_caretctx.py`, `test_cleanup.py` (live xAI), `test_e2e.py`, plus the settings behavior suite `spikes/qt_settings_behavior.py` and the perf gate `tests/perf_settingsui.py`. The E2E test fakes `transcribe` and drives the f13 hotkey — key injection MUST come from a separate process (`keyboard` hides its own injected events from same-process hooks via `is_replaying`), the target window must be launched *after* the App so it keeps foreground focus, and the DESKTOP MUST BE IDLE while it runs (user input steals focus from the paste target; a clipboard sentinel makes that fail loudly, so an intermittent failure while someone is using the machine is the harness, not the app).
- The owner's real API key lives only in `%APPDATA%\Undertone\config.json` now (the old repo-root key file is gone; `tests/test_cleanup.py` reads the key from that config). A key once leaked into a pushed commit — never bundle or commit anything from the repo root beyond code and `assets/`.
- Packaging: `build.bat` → PyInstaller one-file `dist\Undertone.exe` (`undertone.spec`; needs `pip install pyinstaller` once). The spec bundles ONLY `assets/` and keeps its own copy of the version — keep it in sync with `config.APP_VERSION`. Frozen quirks already handled: assets resolve via `_MEIPASS`, `autostart._command()` registers the exe itself. A onefile exe shows as two `Undertone.exe` processes (bootstrap + child); venv `pythonw` similarly shows as stub + base interpreter — either way it's ONE app instance.
- Commit locally at each verified milestone with a proper message, but never push — the owner says "update everything" when he wants the accumulated commits pushed.

## Architecture

Data flow: `hotkey.PushToTalk` (global keyboard hook) → `recorder.Recorder` (sounddevice raw int16 → WAV bytes) → `transcriber.transcribe` (provider-dispatched STT) → `textproc.format_transcript` (corrections + context-aware spacing/caps) → `injector.paste_text` (clipboard + Ctrl+V, then restore) — with `overlay.Overlay` reflecting each state, `settingsui.SettingsWindow` (Qt) for configuration, and `main.App` wiring it all, including the `QSystemTrayIcon`. `ui.py` holds shared imagery + tables only.

**Providers**: STT (`provider`) and AI cleanup (`cleanup_provider`) are independently selectable across xai/openai/openrouter — STT additionally offers `local` (see below); keys live in per-provider config fields (`config.KEY_FIELDS`/`provider_key`), model overrides in `stt_model`/`cleanup_model` (empty = `DEFAULT_STT_MODELS`/`DEFAULT_CLEANUP_MODELS`). Vocabulary biasing is per-provider: xAI `keyterm` fields, OpenAI multipart `prompt`, OpenRouter via the base64-JSON path's `provider.options.<slug>.prompt` (its multipart path accepts but IGNORES `prompt` — that's why the JSON path is used). Cleanup providers all speak the OpenAI chat dialect; only `cleanup.API_URLS` differ. Request shapes are pinned by `tests/test_providers.py` (mocked, no keys needed).

**Local STT** (`localstt.py`, provider id `local`, keyless — `transcribe()` skips the key guard and `KEY_FIELDS` deliberately has no entry): a whisper.cpp `whisper-server.exe` child on a loopback port, POSTed the same multipart dialect (`prompt` carries the vocabulary, so `_strip_prompt_echo` still backstops). Everything installs on demand into `%LOCALAPPDATA%\Undertone` (never roaming) from a sha256-pinned manifest: CPU runtime always (tiny, doubles as fallback), CUDA runtime too when `nvcuda.dll` is present, the ggml model + a Silero VAD model. VAD is why the banned-from-cloud whisper-large-v3-turbo is safe here — the server returns empty text on silence instead of hallucinating; the VAD model (silero-v6.2.0) comes from `ggml-org/whisper-vad`, whisper.cpp's own artifact repo (the same source its `models/download-vad-model.sh` uses — verified official, don't "fix" it to another mirror). If the CUDA server fails to start, `runtime.json` gets `cuda_disabled` and CPU takes over (delete the file to retry GPU). Residency controls are deliberately decoupled: the card's Load/Eject button is a pure runtime action, `local_stt_loaded` means "load on startup" and is set only by its toggle, and `local_stt_idle_minutes` (0 = never) drives an idle auto-eject timer inside localstt (timer body re-checks under the lock, gestures-style); dictating while ejected auto-loads for the session with a "Loading the local model…" pill and flips nothing. A kill-on-close job object ties the child to the app through Task Manager kills; `App._quit` also calls `localstt.shutdown()`. Settings drives install/load/eject on worker threads via the `_queue`/`_drain` pattern with per-percent progress. The `stt_models["local"]` override is a ggml FILENAME in the models dir. Offline logic is pinned by `tests/test_localstt.py`.

**Smart formatting context** comes from three tiers, tried in order: UIA TextPattern2/GetCaretRange (dedicated COM worker thread, 150ms timeout — WPF/browsers), a Win32 `EM_GETSEL`+`WM_GETTEXT` fallback via `SendMessageTimeout` (classic Edit/RichEdit controls, e.g. Notepad; bails at ≥64k chars because EM_GETSEL packs positions into LO/HIWORD), and insertion memory (what Undertone itself last pasted, valid only while the same window is focused and no non-hotkey key was typed since). Terminals/Google Docs/most Electron get memory only. None context = do nothing risky. (A fix-window auto-learning flow existed briefly and was removed 2026-07-11 — the owner prefers manual dictionary entries; don't reintroduce without asking.)

**AI cleanup** (`cleanup.py`, config `ai_cleanup`/`cleanup_model`) is a hybrid: the grok chat model handles the transcript body (fillers, false starts, dictionary variants, mid-sentence casing) via structured output at temperature 0, while `textproc.finalize(model_cased=True)` re-applies the exact dictionary and re-decides the boundary (leading space + sentence-start capital) deterministically — both pipeline branches funnel through `finalize()` so a cleanup timeout can't change dictionary behavior — the probe showed each layer fails where the other is reliable. Any HTTP error/timeout (1.5s connect, 2.5s read) returns None → silent fallback to `format_transcript`. `_drop_echoed_context` cuts a ≥4-char context tail the model may echo. Dictionary reaches three stations: STT `keyterm` hints, exact regex replace, and the model (fuzzy variants). Privacy: ctx + window title go to xAI when enabled — disclosed in the toggle hint.

**Status pill is the product's voice**: every outcome gets feedback — paste confirmation with preview, accent-blue bars + "tap to finish" when hands-free locked (`show_recording(locked=True)`), amber `warn=True` notices (too short, couldn't paste), "Still transcribing…" escalation after 4s, Esc cancels a recording (`TapStateMachine.cancel()`, scan codes resolved once in App). Never-lose-text: if refocusing the target window fails or the paste throws, the text goes to the clipboard + history and the pill points at the re-paste shortcut. History entries are dicts (`ok/text/raw/ts`, failures carry `error` + `wav` for the 3 newest — snapshots deep-copy under the lock). The tray is state-bearing: hotkey tooltip, red-tinted icon while recording, Pause dictation menu item (interacts with shortcut-capture via `_capture_active` — resume during capture must not re-arm hooks). First run shows a "Get started" section (config `onboarded`) with provider/key/test, mic meter, and a practice dictation box. Mic selection is stored by NAME (`input_device`) and resolved to a default-host-API index at stream open (bare names are ambiguous across Windows host APIs).

**Hands-free toggle** is `hotkey.TapStateMachine`: IDLE/HELD/TAP_WAIT/LOCKED behind one RLock, with the double-tap gap measured from the first tap's RELEASE (press-anchored timing silently discarded recordings — see tests/test_gestures.py). The timer body re-checks state under the lock, so a `Timer.cancel()` that loses the race is harmless. Extra global hotkeys (re-paste `ctrl+alt+v` — changeable in Settings→General; optional dedicated toggle, config-only) are registered via `keyboard.add_hotkey` with tracked handles (re-registered on settings change, unregistered during shortcut capture), and their scan codes are excluded from typing detection (which otherwise invalidates insertion memory; typing is observed via the PushToTalk hook's `on_other_key`, not a second keyboard hook; a small `mouse` hook additionally invalidates insertion memory on clicks, which move the caret invisibly).

**Threading is the load-bearing constraint.** The Qt main loop owns all UI. The `keyboard` hook thread and the pipeline worker never touch widgets — every cross-thread hop is a Qt signal emission (queued connection when the emitter is off-thread): `App._post` goes through the `_Dispatcher` signal, `Overlay`'s public API emits `_command`, and `SettingsWindow`'s workers (capture, key tests, local-STT actions) emit their result signals. Tray menu actions arrive on the main thread natively (QSystemTrayIcon has no thread of its own, unlike the old pystray). ALL transcribe/paste/re-paste work runs on ONE pipeline worker consuming `App._pipeline_q` in order — the clipboard, insertion memory, and history assume a single writer (concurrent dictations used to interleave pastes) — and each job runs against a config snapshot taken at dequeue, so a mid-job settings save can't mix policies. The injector's delayed clipboard restore is generation-guarded. Each dictation carries its target hwnd (captured at recording end) through the queue; if the foreground changed by paste time, `caretctx.focus_window` (AttachThreadInput + SetForegroundWindow) restores it before the caret read and paste, and the thief's exe/title is logged at WARNING (field reports of pastes "pulled out of the focused window"). Keep new features on these patterns.

**Overlay is a translucent QWidget** (`Qt.FramelessWindowHint | Tool | WindowStaysOnTopHint | WindowTransparentForInput | WindowDoesNotAcceptFocus` + `WA_TranslucentBackground`), painted with QPainter; fading goes through `windowOpacity` and no-stale-flash is "lay out content before `show()`, fade in from 0". One rendering invariant: pill LABELS must be pre-rendered into an alpha `QImage` (`Overlay._render_text`) — drawing text straight onto the translucent window gets ClearType subpixel AA, whose colored fringes assume an opaque background (ui-verifier caught this in the port; the QImage raster path antialiases in grayscale). Recording/transcribing pills are animation-only (no text) by design; only errors and notices carry text, shown verbatim from `TranscriptionError`.

**The settings window is Qt widgets + QSS** (`settingsui.SettingsWindow`, a QObject owning a top-level QWidget). Qt paints the whole window into one backing store, so live resize is native (~4-5ms/step; gate is <18). The QSS is generated from theme.py constants; the handful of custom-painted widgets (Toggle, Meter, NavItem, ElideLabel) live at the top of settingsui.py. Its conventions:
- Sections rebuild on select (a fresh widget per visit — dynamic content stays honest); per-section QTimers (history poll, local-card poll, mic test, practice poll) are PARENTED TO THE SECTION WIDGET, so switching sections retires them automatically. The mic-test `Recorder` is the one resource needing explicit stop (hardware, not a widget).
- Every field change autosaves through `_apply` → `on_save(merged config)` + the "✓ Saved" toast. There is no Save-all action.
- Shortcut capture runs `keyboard.read_hotkey` on a worker thread bracketed by `on_capture_start/end` (App suspends its hooks); results come back via the `_captured` signal; Esc cancels; duplicates across hotkey/repaste/toggle are rejected; window close is refused mid-capture.
- A stylesheet-styled QComboBox loses its native chevron — QSS `::down-arrow` points at a runtime-generated PNG in %TEMP% (`_chevron_url`). Single-line text that must never push siblings out of a row uses `ElideLabel` (paint-time elide, Ignored size policy) — a setText-on-resize elide loop once pushed the History Copy buttons off-panel.
- Perf gate: `tests/perf_settingsui.py` (every section, <18ms/step median). Run after touching settings layout code.
`ui.py` retains `pretty_combo`, the Pillow icon/glyph drawing, and shared tables (LANGUAGES/PROVIDERS_UI/SECTIONS…) — main.py and settingsui import from it; PIL images convert to Qt via PNG bytes (`main._qicon`, `settingsui._pil_pixmap`). The One-Dark slate ladder lives in `theme.py` (single source for ui/settingsui/overlay). Windows polish: dark title bar via DWM attribute 20 on a private `ctypes.WinDLL("dwmapi")`; window icons via `setWindowIcon(QIcon(icon.ico))` (Qt picks correct frame sizes itself).

**High-DPI**: Qt handles DPI awareness and scaling on its own — all pixel measures in overlay.py/settingsui.py are logical pixels, no scaling helper needed (`theme.sc()`/`init_dpi()` were retired with the Tk stack). The one DPI-sensitive spot is `Overlay._render_text`, which sizes its QImage by `devicePixelRatioF()`.

**Config**: `%APPDATA%\Undertone\config.json`, read with `utf-8-sig`, on-disk values merged over `DEFAULT_CONFIG`. Saves are atomic (temp file + `os.replace`). API keys are DPAPI-encrypted at rest (`dpapi:<b64>` values bound to the Windows user; plaintext in memory; legacy plaintext keys still load and encrypt on the next save — pinned by `tests/test_providers.py`). Legacy `PushToTalkSTT` migrations live in `config.py` (dir move — must handle the dir already existing, since logging creates it before `load_config`) and `autostart.py` (HKCU Run value).

**Icon assets** (`assets/icon.png`, `icon.ico`) are post-processed AI art: the square's colour is bled under the transparent rounded corners (prevents white halos on downscale) and the .ico carries individually resized + unsharp-masked 16–48px frames. Regenerate with the same care or small sizes go muddy.

Other Windows realities: NEVER set `.argtypes`/`.restype` on `ctypes.windll.*` functions — that cache is process-wide shared, and one module's prototypes poison another's calls (a `CreateDIBSection` prototype set in ui.py silently killed every overlay pill render); use a private `ctypes.WinDLL("...")` instance whenever you set prototypes. Pasting into elevated apps requires Undertone to be elevated too; injected key events are filtered from the hotkey hook by their missing scan code; recordings under ~0.3s are discarded (`MIN_AUDIO_BYTES`); silent-audio hallucination is handled by MODEL CHOICE, not a local noise gate (a windowed-RMS gate was tried and removed 2026-07-13 — the owner prefers trusting server-side no-speech rejection): `DEFAULT_STT_MODELS` must only name models that reject no-speech audio (whisper-large-v3-turbo does NOT — it invents fragments like "Of the"; the transcribe-family models do), and `transcriber._strip_prompt_echo` backstops the vocabulary-prompt echo models leak on silence (matches the EXACT comma-joined term sequence — keyword matching false-positived on dictation ABOUT the vocabulary feature; strips echo around surviving speech, raises loudly only on pure echo); `transcriber.PROVIDERS` is the extension point for additional STT providers.
