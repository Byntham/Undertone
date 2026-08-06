# Handoff: session turn buffer

**Branch:** `feat/session-turn-buffer`  
**Worktree (typical):** `~/.t3/worktrees/Undertone/session-turn-buffer`  
**Status:** Implemented and dogfooding. Not merged to `main` as of this write-up.  
**Deeper design notes:** [`docs/design/session-turn-buffer.md`](../design/session-turn-buffer.md)

This is a **product-direction change**, not a small feature. Read this before changing dictation, paste, overlay, or formatting context.

---

## Intent (why this exists)

Graham’s goal is **higher bandwidth from mind → computer**, especially into AI agents, with a **pleasant** loop and **as little non-contributing input as possible** (no fixing casing/spaces/seams by hand).

Caret-context formatting failed that goal: many text boxes cannot be read, so quality was uneven and repair was common.

**Reframe that drove the architecture:**

> You don’t need “text around the caret” as a product feature.  
> You need **dictation that joins the user’s writing correctly**.

For fragmented speech (thoughts arrive in pieces), the right unit is not “one paste per release.” It is:

**Utterance = fragment of a turn → stack → commit once.**

Undertone **owns the open turn**. The OS caret is optional enhancement later, not the foundation.

Longer term, Neuralink-class I/O is the horizon; until then, voice + an owned buffer + low-repair publish is the practical channel.

---

## What “done so far” means

### Stack mode (default on this branch)

```text
PTT hold → speak fragment → release
  → STT → prepare against buffer tail (not caret) → append to open turn
  → draft panel shows the stack (no paste into the target app)

…repeat as thoughts arrive…

commit hotkey → paste full joined turn once → clear buffer
```

### Instant mode (escape hatch)

Previous behavior: each release prepares and pastes immediately. Still available in settings.

### User-facing controls (hotkeys, not tray)

| Action | Default (configurable) |
|--------|-------------------------|
| Dictate fragment | existing PTT |
| Commit open turn | `ctrl+alt+enter` |
| Scratch last fragment | `ctrl+alt+backspace` |
| Discard whole turn | `ctrl+alt+shift+backspace` |

Tray deliberately does **not** host these actions (wrong interaction mode for a high-bandwidth loop).

### Draft panel

A separate, non-focusable panel above the status pill while a turn is open. It
shows the joined turn as continuous text with a simple header (`Open turn · N fragments`). The
header uses Electron's native drag region, with the controls explicitly excluded.
The window is edge-resizable, and the snap control restores its default
bottom-center location. The upper-right X
discards the turn through the ordered pipeline queue. Position and size remain
stable across turns for the current app session. The scrollable text preview
follows the newest text.
It accepts only these pointer interactions and never takes keyboard focus. No
char counts (noise). Still no full editor—glanceable truth, not a second chat app.

The window starts at its 96 px minimum height and only changes size through a
user edge-resize. New fragments scroll within that size. Do not auto-resize the
native window from renderer content. When the initial empty draft is published,
do not call `hide()` unless the window is visible. A redundant hide after the
renderer loads can leave Electron's native hit-test map non-interactive on
Windows until a later window transition.

---

## Architecture (where the truth lives)

```text
TurnBuffer (main process, in-memory)
    ↑ append / scratch / clear
DictationJobRunner  ← stack vs instant from config.dictation_mode
    ↑
DictationPipelineQueue  (dictate | commit | scratch | discard | repaste | retry)
    ↑
main.ts hotkeys + overlay draft publish
```

| Concern | Owner |
|---------|--------|
| Open turn text | `TurnBuffer` — source of truth for stack formatting and commit body |
| Format left context (stack) | `turnBuffer.contextBefore()` → `prepareText` (skips UIA caret) |
| Format left context (instant) | existing caret → insertion memory path |
| Paste | only on **commit** (stack) or each job (instant) |
| History | **committed** turns (and instant pastes); not every stacked fragment |
| Insertion memory | updated on successful **commit** / instant paste, not on stack append |
| Overlay status pill | ephemeral: recording / turn feedback / errors |
| Overlay draft | durable while open turn non-empty; independent of pill hide timers |

**Invariants still hold:** password fields never read; only left context to AI cleanup; overlay never takes focus; single ordered dictation queue (commit/scratch/discard must go through the queue).

---

## Key files

| Path | Role |
|------|------|
| `electron/src/core/turnBuffer.ts` | Open-turn data model |
| `electron/src/core/dictationRunner.ts` | Stack append, commit, scratch, discard |
| `electron/src/core/pipelineQueue.ts` | FIFO jobs including turn ops |
| `electron/src/core/textPreparation.ts` | Prepare pipeline (context injected by main) |
| `electron/src/main/main.ts` | Mode wiring, hotkeys, draft IPC |
| `electron/src/renderer/overlay/*` | Click-through status pill UI |
| `electron/src/renderer/turn-draft/*` | Movable open-turn draft + discard UI |
| `electron/src/core/config.ts` | `dictation_mode`, turn hotkeys, idle timeout |
| `electron/src/shared/settings.ts` | Settings surface for mode/hotkeys |
| `docs/design/session-turn-buffer.md` | Longer design + open questions |

---

## Product decisions already locked

1. **Fragment-of-turn** is the primary model for agent work (not paste-per-utterance).  
2. **Buffer-owned context** beats unreliable caret reads for stack mode.  
3. **Commit is intentional** — extra gesture is acceptable for multi-fragment quality.  
4. **Focus at commit time** (v1) — do not restore a target captured at first fragment.  
5. **Paste failure keeps the open turn** (clipboard fallback only).  
6. **External typing does not invalidate** the open turn (unlike insertion memory).  
7. **In-memory only** — quit loses an unfinished turn.  
8. **Hotkeys > tray** for turn actions.  
9. **Draft is glance-only** — movable, resizable, and discardable, but not a focusable editor.

---

## Explicitly not done (do not assume)

- Voice “scratch that” / command grammar  
- Persist open turn across restart  
- Re-run AI cleanup on the full turn at commit  
- Browser extension / TSF / better caret readers as the main path  
- Agent-specific genre prompts  
- Shipping decision: whether `stack` remains default on `main` after merge  
- Focus restore to first-fragment target  

Phase 3 ideas in the design doc are **out of scope until dogfood demands them**.

---

## How to verify quickly

From `electron/` on this branch:

```bat
npm ci
npm run verify
npm run test:turn-draft-native
```

The native draft test moves the mouse and is valid only while the desktop is idle.

Manual dogfood:

1. Settings → Dictation mode = **Stack fragments**.  
2. Speak several fragments without focusing anything special → the continuous draft follows the newest text.
3. Focus an agent/chat field → commit hotkey → one paste of the full turn.  
4. Drag and resize the draft; confirm its geometry survives a commit/new turn and
   the target retains keyboard focus.
5. Click the snap control; confirm the draft returns above the bottom-center pill.
6. Stack more fragments than fit; confirm the text preview scrolls to the newest text.
7. Click the draft X; confirm the full turn is discarded and the panel hides.
8. Scratch last / discard via hotkeys; confirm draft updates.
9. Instant mode still pastes each release.

If `Undertone.WinHost.exe` is running, full `verify` clean may EPERM; quit the app or build without clean (`tsc -p tsconfig.build.json` + `vite build`).

---

## Guidance for a future agent

**Protect the north star:** reduce repair and raise mind→agent throughput. Do not “fix” stack mode by re-centering on UIA caret reads.

**When changing this area:**

- Keep stack prepare on **buffer context**, not caret.  
- Keep commit/scratch/discard on the **pipeline queue**.  
- Keep the draft **non-focusable**.  
- Prefer hotkey/voice affordances over tray or modal UI.  
- Measure success as fewer manual seam edits and smoother multi-fragment agent prompts—not complete surrounding-text coverage of every HWND.

**If Graham says continue:** prefer dogfood-driven polish (hotkeys, draft copy, defaults) over new integrations, unless he explicitly wants the next bandwidth layer (agent genre defaults, voice scratch, persist draft).

---

## Commit trail (this branch)

Approximate progression:

1. Stack buffer + commit + settings + queue jobs  
2. Hotkeys + open-turn draft overlay; tray turn actions removed  
3. Drop char-count noise from draft/status feedback  

Check `git log` on `feat/session-turn-buffer` for exact messages.
