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

Non-focusable, click-through panel above the status pill while a turn is open. Shows numbered fragments and a simple header (`Open turn · N fragments`). No char counts (noise). Still no full editor—glanceable truth, not a second chat app.

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
| `electron/src/renderer/overlay/*` | Pill + draft panel UI |
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
9. **Draft is glance-only** — not a focusable editor (yet).

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
```

Manual dogfood:

1. Settings → Dictation mode = **Stack fragments**.  
2. Speak several fragments without focusing anything special → draft panel grows.  
3. Focus an agent/chat field → commit hotkey → one paste of the full turn.  
4. Scratch last / discard via hotkeys; confirm draft updates.  
5. Instant mode still pastes each release.

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
