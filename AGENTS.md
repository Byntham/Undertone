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

Windows-only push-to-talk dictation tray app: hold a global hotkey, speak, release — audio is transcribed via API and pasted into the focused text box. Python 3.11 + tkinter, no build step, no test suite.

## Commands

```
.venv\Scripts\python.exe main.py                        # run with console (see tracebacks)
run.bat                                                  # run detached via pythonw (how users launch it)
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m py_compile *.py              # syntax check (no linter configured)
```

- Always use the project venv; the `python` on PATH belongs to an unrelated tool's venv. Prefer `python -m pip` over `pip.exe`.
- Smoke test: launch via pythonw, wait a few seconds, read `%APPDATA%\Undertone\app.log`, kill the process. A silent instant exit with an empty log usually means another instance holds the `Undertone_SingleInstance` mutex — check for running `pythonw` first.
- UI verification: instantiate `SettingsWindow` / `Overlay` directly on a withdrawn `tk.Tk()` with a fake `level_getter`, call their show methods, capture with `PIL.ImageGrab` after `root.after` delays. Prefer delegating capture+judgment to the `ui-verifier` agent (`.claude/agents/ui-verifier.md`) — the main session should consume verdicts, not screenshots.
- Tests live in `tests/` (plain assert scripts, no pytest): `test_textproc.py`, `test_gestures.py`, `test_providers.py` (mocked, keyless), `test_caretctx.py`, `test_cleanup.py` (live xAI), `test_e2e.py`. The E2E test fakes `transcribe` and drives the f13 hotkey — key injection MUST come from a separate process (`keyboard` hides its own injected events from same-process hooks via `is_replaying`), the target window must be launched *after* the App so it keeps foreground focus, and the DESKTOP MUST BE IDLE while it runs (user input steals focus from the paste target; a clipboard sentinel makes that fail loudly, so an intermittent failure while someone is using the machine is the harness, not the app).
- The owner's real API key lives only in `%APPDATA%\Undertone\config.json` now (the old repo-root key file is gone; `tests/test_cleanup.py` reads the key from that config). A key once leaked into a pushed commit — never bundle or commit anything from the repo root beyond code and `assets/`.
- Packaging: `build.bat` → PyInstaller one-file `dist\Undertone.exe` (`undertone.spec`; needs `pip install pyinstaller` once). The spec bundles ONLY `assets/` and keeps its own copy of the version — keep it in sync with `config.APP_VERSION`. Frozen quirks already handled: assets resolve via `_MEIPASS`, `autostart._command()` registers the exe itself. A onefile exe shows as two `Undertone.exe` processes (bootstrap + child); venv `pythonw` similarly shows as stub + base interpreter — either way it's ONE app instance.
- Commit locally at each verified milestone with a proper message, but never push — the owner says "update everything" when he wants the accumulated commits pushed.

## Architecture

Data flow: `hotkey.PushToTalk` (global keyboard hook) → `recorder.Recorder` (sounddevice raw int16 → WAV bytes) → `transcriber.transcribe` (provider-dispatched STT) → `textproc.format_transcript` (corrections + context-aware spacing/caps) → `injector.paste_text` (clipboard + Ctrl+V, then restore) — with `overlay.Overlay` reflecting each state and `ui.py` providing the tray icon + settings window. `main.App` wires it all.

**Providers**: STT (`provider`) and AI cleanup (`cleanup_provider`) are independently selectable across xai/openai/openrouter; keys live in per-provider config fields (`config.KEY_FIELDS`/`provider_key`), model overrides in `stt_model`/`cleanup_model` (empty = `DEFAULT_STT_MODELS`/`DEFAULT_CLEANUP_MODELS`). Vocabulary biasing is per-provider: xAI `keyterm` fields, OpenAI multipart `prompt`, OpenRouter via the base64-JSON path's `provider.options.<slug>.prompt` (its multipart path accepts but IGNORES `prompt` — that's why the JSON path is used). Cleanup providers all speak the OpenAI chat dialect; only `cleanup.API_URLS` differ. Request shapes are pinned by `tests/test_providers.py` (mocked, no keys needed).

**Smart formatting context** comes from three tiers, tried in order: UIA TextPattern2/GetCaretRange (dedicated COM worker thread, 150ms timeout — WPF/browsers), a Win32 `EM_GETSEL`+`WM_GETTEXT` fallback via `SendMessageTimeout` (classic Edit/RichEdit controls, e.g. Notepad; bails at ≥64k chars because EM_GETSEL packs positions into LO/HIWORD), and insertion memory (what Undertone itself last pasted, valid only while the same window is focused and no non-hotkey key was typed since). Terminals/Google Docs/most Electron get memory only. None context = do nothing risky. (A fix-window auto-learning flow existed briefly and was removed 2026-07-11 — the owner prefers manual dictionary entries; don't reintroduce without asking.)

**AI cleanup** (`cleanup.py`, config `ai_cleanup`/`cleanup_model`) is a hybrid: the grok chat model handles the transcript body (fillers, false starts, dictionary variants, mid-sentence casing) via structured output at temperature 0, while `textproc.seam()` re-decides the boundary (leading space + sentence-start capital) deterministically — the probe showed each layer fails where the other is reliable. Any HTTP error/timeout (1.5s connect, 2.5s read) returns None → silent fallback to `format_transcript`. `_drop_echoed_context` cuts a ≥4-char context tail the model may echo. Dictionary reaches three stations: STT `keyterm` hints, exact regex replace, and the model (fuzzy variants). Privacy: ctx + window title go to xAI when enabled — disclosed in the toggle hint.

**Status pill is the product's voice**: every outcome gets feedback — paste confirmation with preview, accent-blue bars + "tap to finish" when hands-free locked (`show_recording(locked=True)`), amber `warn=True` notices (too short, couldn't paste), "Still transcribing…" escalation after 4s, Esc cancels a recording (`TapStateMachine.cancel()`, scan codes resolved once in App). Never-lose-text: if refocusing the target window fails or the paste throws, the text goes to the clipboard + history and the pill points at the re-paste shortcut. History entries are dicts (`ok/text/raw/ts`, failures carry `error` + `wav` for the 3 newest — snapshots deep-copy under the lock). The tray is state-bearing: hotkey tooltip, red-tinted icon while recording, Pause dictation menu item (interacts with shortcut-capture via `_capture_active` — resume during capture must not re-arm hooks). First run shows a "Get started" section (config `onboarded`) with provider/key/test, mic meter, and a practice dictation box. Mic selection is stored by NAME (`input_device`) and resolved to a default-host-API index at stream open (bare names are ambiguous across Windows host APIs).

**Hands-free toggle** is `hotkey.TapStateMachine`: IDLE/HELD/TAP_WAIT/LOCKED behind one RLock, with the double-tap gap measured from the first tap's RELEASE (press-anchored timing silently discarded recordings — see tests/test_gestures.py). The timer body re-checks state under the lock, so a `Timer.cancel()` that loses the race is harmless. Extra global hotkeys (re-paste `ctrl+alt+v` — changeable in Settings→General; optional dedicated toggle, config-only) are registered via `keyboard.add_hotkey` with tracked handles (re-registered on settings change, unregistered during shortcut capture), and their scan codes are excluded from typing detection (which otherwise invalidates insertion memory; typing is observed via the PushToTalk hook's `on_other_key`, not a second hook).

**Threading is the load-bearing constraint.** The Tk main loop owns all UI. The `keyboard` hook thread, pystray thread, and the pipeline worker never touch widgets — every cross-thread hop goes through a `queue.Queue` drained by a `root.after` poller (`App._post`, `Overlay._queue`, `SettingsWindow._queue`). ALL transcribe/paste/re-paste work runs on ONE pipeline worker consuming `App._pipeline_q` in order — the clipboard, insertion memory, and history assume a single writer (concurrent dictations used to interleave pastes). The injector's delayed clipboard restore is generation-guarded. Each dictation carries its target hwnd (captured at recording end) through the queue; if the foreground changed by paste time, `caretctx.focus_window` (AttachThreadInput + SetForegroundWindow) restores it before the caret read and paste, and the thief's exe/title is logged at WARNING (field reports of pastes "pulled out of the focused window"). Keep new features on these patterns.

**Overlay rendering is not normal Tk.** The status pill is a per-pixel-alpha layered window: each frame is composed in Pillow (4x supersampled; text at 1x) and blitted with `UpdateLayeredWindow` as premultiplied BGRA. Two invariants:
- Never set Tk `-alpha` or `-transparentcolor` on this window — `SetLayeredWindowAttributes` and `UpdateLayeredWindow` are mutually exclusive; fading goes through `BLENDFUNCTION.SourceConstantAlpha`.
- Always push the new frame *before* `deiconify()` — a layered window keeps showing its last bitmap, so mapping first flashes the previous state.
Recording/transcribing pills are animation-only (no text) by design; only errors and notices carry text, shown verbatim from `TranscriptionError`.

**Styling is hand-rolled**, not ttk: plain tk widgets, the One-Dark-derived slate ladder lives in `theme.py` (single source for `ui.py` and `overlay.py`), Pillow-rendered imagery. Rounded surfaces are placed image underlays composed 9-slice from cached supersampled corner masters — never full-image LANCZOS per size. Three perf invariants: section switches paint atomically under `WM_SETREDRAW` suppression (try/finally — paint must never stay off); `<Configure>` handlers do bookkeeping only, with underlay/wraplength work in a trailing settle pass; and interactive resizes snapshot-freeze — every Tk widget is a real child HWND on Windows (~60ms/step to revalidate them all), so the first size change of a storm PrintWindow-captures the client into one stale bitmap and unmaps the placed host tree until 150ms of quiet (~7ms/step during the drag). Do NOT reintroduce a WndProc subclass for WM_ENTER/EXITSIZEMOVE — the ctypes callback hard-crashed the process; the Configure-edge trigger is the safe variant. Regressing any of these brings back 4fps drags / pop-in ghosting. The settings window is grouped setting cards (`_card`/`_row_card`/`_toggle_card`) with pill-shaped `RoundButton`s (Pillow background + Tk `compound="center"` text). Windows polish via ctypes: dark title bar (DWM attribute 20/19), crisp taskbar/title-bar icons via `WM_SETICON` with exact-size frames from `assets/icon.ico` (Tk's `iconbitmap` alone registers only the 16px frame, which Windows scales blurrily).

**High-DPI**: `theme.init_dpi()` (called at the top of main.py, before any Tk/pixel work) makes the process system-DPI aware; every pixel measure in ui.py/overlay.py goes through `theme.sc()`. Point-sized Tk fonts scale on their own — new pixel constants must use `sc()` or they'll be tiny on scaled displays. overlay.py scales its constants at import time, which is why init_dpi must run before it is imported.

**Config**: `%APPDATA%\Undertone\config.json`, read with `utf-8-sig`, on-disk values merged over `DEFAULT_CONFIG`. Legacy `PushToTalkSTT` migrations live in `config.py` (dir move — must handle the dir already existing, since logging creates it before `load_config`) and `autostart.py` (HKCU Run value).

**Icon assets** (`assets/icon.png`, `icon.ico`) are post-processed AI art: the square's colour is bled under the transparent rounded corners (prevents white halos on downscale) and the .ico carries individually resized + unsharp-masked 16–48px frames. Regenerate with the same care or small sizes go muddy.

Other Windows realities: NEVER set `.argtypes`/`.restype` on `ctypes.windll.*` functions — that cache is process-wide shared, and one module's prototypes poison another's calls (a `CreateDIBSection` prototype set in ui.py silently killed every overlay pill render); use a private `ctypes.WinDLL("...")` instance whenever you set prototypes. Pasting into elevated apps requires Undertone to be elevated too; injected key events are filtered from the hotkey hook by their missing scan code; recordings under ~0.3s are discarded (`MIN_AUDIO_BYTES`); `transcriber.PROVIDERS` is the extension point for additional STT providers.
