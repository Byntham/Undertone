# Session turn buffer

**Branch / worktree:** `feat/session-turn-buffer`  
**Status:** hotkeys + movable open-turn draft with discard control; dogfood continues
**Decision:** utterance = **fragment of a turn** — release stacks; commit sends.

## Problem

Undertone formats by reading caret context (UIA → Win32 → insertion memory). Many targets expose no text, so seams and cleanup degrade and force manual repair. Repair is non-contributing input: it burns bandwidth between mind and agents.

North star: maximize trusted intent throughput into AI, with minimal eyes-on-field and minimal edit tax.

## Product decision

Undertone **owns the open turn**. Each dictate appends a raw fragment and a
display snapshot to a session buffer. Cleanup uses only buffer-owned text, with
timing selected by the stack cleanup strategy. Nothing is injected into the
foreign app until an explicit **commit**.

```text
hold PTT → speak fragment → release
        → STT → apply selected stack cleanup timing → update turn snapshot
        → (repeat)
commit gesture → paste/send full turn → clear or arm next turn
```

This matches fragmented speech as thoughts form: partial phrases stack into one agent-ready turn.

## Goals

- Always-available left context for smart formatting and AI cleanup (no caret required).
- Multi-utterance turns without mid-turn paste noise in the agent field.
- Eyes-off by default: dictate never steals focus; buffer UI is optional.
- One cheap commit gesture to land the full turn.
- Pleasant low-friction path for agent work; keep an escape hatch for instant one-shot paste.

## Non-goals (v1)

- Full rich-text editor or second chat client.
- Browser extension / TSF / deeper OS readers.
- Voice command grammar beyond maybe “scratch that” later.
- Perfect mid-field surgical insert when user clicked into the middle of existing text.
- OCR / screen capture.
- Replacing history; history remains a log of committed (and optionally staged) outcomes.

## User model

| Concept | Meaning |
|---------|---------|
| **Fragment** | One PTT hold/release cycle after STT + prepare |
| **Open turn** | Ordered list of committed-to-buffer fragments not yet published |
| **Commit** | Publish the joined turn into the focused target (paste path) |
| **Discard** | Drop the open turn without pasting |
| **Instant mode** | Optional legacy-like path: each fragment pastes immediately (see modes) |

Default for this feature: **stack mode** (fragment of a turn).

### Happy path (agent)

1. Focus agent input (or leave focus there).
2. Hold PTT, speak a piece of the thought, release → fragment lands in buffer only.
3. Repeat as thoughts arrive.
4. Commit → full turn pastes once into the agent.
5. Open turn clears; next dictate starts a new turn.

### Cleanup timing experiment

Stack mode exposes two interchangeable strategies. They share the same raw
fragment source and display-snapshot buffer, so unwanted strategies can be
deleted after dogfood without changing the rest of the turn pipeline.
The selected strategy is fixed when an open turn begins; setting changes apply
to the next turn.

| Strategy | On each fragment | On commit |
|----------|------------------|-----------|
| **Whole turn after every fragment** (`live-full`, default) | Join all raw fragments, clean the whole turn with no prior model context, replace the display snapshot | Paste current snapshot |
| **Whole turn only when committing** (`commit-full`) | Rebuild a deterministic, no-AI full-turn preview | Clean the whole raw turn, replace the snapshot, paste it |

All cleanup calls are stateless. A whole-turn call sends the current raw turn
once; it does not retain earlier requests as conversation history. Instant mode
continues to use caret/insertion context and is unaffected by this setting.

## Data model

```ts
interface TurnFragment {
  id: string;
  raw: string;          // original STT transcript; source for whole-turn cleanup
  text: string;         // complete display snapshot after this fragment
  createdAt: number;
}

interface OpenTurn {
  id: string;
  fragments: TurnFragment[];
  /** Latest display snapshot; source of truth for preview + commit body */
  text: string;
  startedAt: number;
  updatedAt: number;
  /** Optional: HWND / process hint when turn started; not required for formatting */
  targetHint?: string;
}

interface TurnBufferState {
  mode: "stack" | "instant";
  open: OpenTurn | null;
}
```

Invariants:

- At most one open turn.
- `open.text === fragments.at(-1).text`; each fragment stores the snapshot needed to make Scratch exact.
- Password fields: never read caret (unchanged). Commit still pastes if user commits while focused there — same as today; reading remains forbidden.
- Main process owns the buffer (single-writer, same as dictation queue).

Persistence (v1): **in-memory only**. Survive app restart empty. Optional later: `%APPDATA%` draft if crash mid-turn proves painful.

## Lifecycle

### Start turn

Implicit: first successful fragment while `open === null` creates `OpenTurn`.

### Append fragment

On successful STT (non-empty):

1. Add the raw transcript to the in-memory source turn.
2. Apply the selected cleanup timing as described above. Stack mode never reads the native caret.
3. Store the resulting complete display snapshot on the new fragment and as `open.text`.
4. Overlay: brief success showing fragment or “+N · turn ready” (see UI).
5. **No paste.**

### Commit

User fires commit hotkey (or tray action):

1. If `open === null` or `open.text` empty → no-op or soft message.
2. Snapshot `text = open.text`; clear open turn **before** paste attempt? Prefer clear-after-success to allow retry on paste failure — see below.
3. Restore/focus target like today’s dictation paste path.
4. Paste `text` via existing paster (clipboard + SendInput).
5. On success: clear open turn; register history success; update insertion memory with full turn text; dismiss overlay.
6. On failure: keep open turn intact; clipboard fallback message like today (“press repaste…”); do not clear.

### Discard

Hotkey or tray: clear open turn; overlay confirmation.

### Scratch last fragment (v1.1 candidate)

Remove the last fragment and restore `open.text` from the preceding fragment's
snapshot. This does not call cleanup again.

### Invalidation

Do **not** clear the open turn on arbitrary key/mouse in the foreign app (unlike insertion memory). The buffer is ours; external typing does not edit it.

An open turn does not expire. Clear only on commit success, explicit discard,
mode switch away, or app quit.

## Modes

| Mode | Release behavior | Commit |
|------|------------------|--------|
| **stack** (default for this work) | Append to open turn | Required to paste |
| **instant** | prepare + paste immediately (today); still may record to a side journal later | N/A |

v1 settings:

- `dictation_mode: "stack" | "instant"` (default `"stack"` on the feature branch).
- `stack_cleanup_strategy: "live-full" | "commit-full"` (default `"live-full"`).

Instant mode preserves current muscle memory for search boxes and one-liners.

## Gestures

| Action | Proposed default | Notes |
|--------|------------------|-------|
| Dictate fragment | existing `hotkey` (PTT) | Unchanged |
| Commit turn | new `commit_hotkey` e.g. `ctrl+alt+enter` | Must not conflict with PTT |
| Discard turn | new `discard_hotkey` or tray-only in v1 | Tray-only is OK for v1 to reduce binding sprawl |
| Repaste last **committed** | existing `repaste_hotkey` | Unchanged; does not commit open turn |
| Scratch last fragment | `ctrl+alt+backspace` | Hold modifiers and tap the trigger repeatedly |

Commit must work when the agent field is focused; it must **not** require focusing Undertone.

Scratch and Discard each contain exactly one non-modifier trigger key plus
optional modifiers. Their modifiers must match exactly when the trigger goes
down, and holding the modifiers while tapping the trigger repeatedly fires one
action per tap. Commit and Re-paste may instead be modifier-only chords; they
complete only after full chord release because physical modifiers left down can
alter their injected paste gesture. A modifier-only action is cancelled if any
other key joins it and cannot re-arm until its chord is fully released. PTT
retains hold/release semantics.

## UI / overlay

The status overlay remains non-focusable and click-through. The open-turn draft
is a separate non-focusable window: its header accepts dragging and its close
control discards through the ordered pipeline queue.

| State | Overlay idea |
|-------|----------------|
| Recording / transcribing | unchanged |
| Fragment stacked | success pulse + short preview of fragment, or `Turn · 3` / char count |
| Open turn waiting | optional subtle idle badge while `open` non-null (avoid nagging) |
| Commit success | brief success, then hide |
| Commit fail | warning + clipboard message |
| Discard | brief “Turn discarded” |

The draft header uses Electron's native drag region to reposition the window,
with the adjacent controls explicitly excluded. The window can be resized from
its edges. A snap control returns it to the default bottom-center
position; an X discards the full open turn. The chosen position and size remain
for later turns during the app session. The joined turn is shown as continuous
text and scrolls to keep the newest text visible. None of these interactions activates or focuses the window,
so the user's target keeps keyboard focus.

The draft starts at its 96 px minimum height and changes size only when the user
resizes it. New fragments scroll inside the current bounds. Do not resize the
native window in response to renderer content changes. The initial empty publish
must also avoid calling `hide()` when the window is already hidden: on Windows,
that redundant native transition leaves Electron's otherwise-correct hit-test
map intermittently non-interactive.

Optional later: hotkey opens a **read-only or light-edit** turn panel (focus only when user asks). Not required for v1 dogfood if overlay + commit are solid.

## Formatting pipeline changes

Today (`prepareText`):

1. Optionally acquire caret / insertion memory.
2. AI cleanup with `text_before_cursor = before`.
3. `finalize` with before/after seams.

Stack mode selects AI or deterministic isolated whole-turn preparation. Every
stack path uses `before = null` and `after = null`; no stack path reads the OS
caret.

Caret / insertion memory: **skipped for stack-mode prepare**. Insertion memory still updates **on commit** with the full turn (helps instant mode and any future hybrid).

Left-only-to-AI rule unchanged: a stack request contains the whole raw turn as
its transcript and no OS context. It never sends OS right-side text.

## Integration with existing architecture

```text
PTT release → audio → queue job
                 ↓
         DictationJobRunner (stack branch)
                 ↓
         STT → selected cleanup timing → TurnBuffer snapshot
                 ↓
         overlay success (no paster.paste)

commit hotkey → queue commit job (ordered with dictation queue)
                 ↓
         paste(open.text) → history → insertionMemory → clear open
```

Use the **single dictation queue** so commit cannot race mid-append. Commit enqueues like repaste.
Mode changes enqueue a synchronous transition in the same queue. Jobs ahead of
the transition finish under the old mode; jobs behind it snapshot the new mode.
Switching from Stack to Instant clears the draft inside that transition.

Focus restore: on **commit**, reuse dictation target capture rules. Options:

- **A.** Capture foreground at commit time (simple; user focuses agent then commits).
- **B.** Capture target at first fragment of the turn and restore on commit.

**Recommendation:** A for v1 (user is already focusing the agent when ready to send). B is a nicety if commit happens while user glanced elsewhere.

## Privacy

- Open turn lives in main process memory; not sent anywhere except:
  - cleanup provider (whole raw turn only),
  - STT provider (audio / fragment only),
  - paste target on commit.
- Do not write open turns to disk in v1.
- History: log **committed** turns as today; optionally log fragments only in verbose debug.

## Testing plan

- Unit: each cleanup strategy's request timing and context; Scratch snapshot restore; commit pastes the selected result; paste failure preserves turn; discard; mode switch.
- Unit: stack mode never calls `getCaretContext`.
- Integration: queue ordering — fragment job then commit; jobs around a mode transition use the correct mode.
- Unit: exact-modifier trigger shortcuts, repeat taps with held modifiers, and no Scratch/Discard overlap.
- Manual dogfood: multi-fragment agent prompt in Claude/Codex/chat; confirm zero caret dependency in Notepad with focus elsewhere during fragments.

## Implementation phases

### Phase 0 — this design (done when accepted)

### Phase 1 — core buffer + stack path

- `TurnBuffer` module in main/core.
- Config: `dictation_mode` and `commit_hotkey`.
- Branch `DictationJobRunner` (or wrapper): stack vs instant.
- Commit + discard via queue.
- Overlay signals for stacked / commit.
- Tests green; `npm run verify`.

### Phase 2 — dogfood polish

- Better overlay preview (turn size, last fragment).
- Scratch last fragment.
- Settings UI for mode + commit hotkey.
- Decide shipping default mode.

### Phase 3 — later leverage (out of scope now)

- Agent genre defaults.
- Explicit Continue/New only if still needed.
- Browser bridge / sensors as optional upgrade.
- Persist draft turn across restart.

## Risks

| Risk | Mitigation |
|------|------------|
| Forgot to commit; spoke “into the void” | Overlay shows turn armed; optional sound on stack; idle warning |
| Extra gesture vs today | Instant mode remains; stack is for agent/long turns |
| Whole-turn requests grow with long turns | Intentional quality experiment; compare latency and remove losing strategies after dogfood |
| Commit hotkey collision | Settings + conflict detection like existing shortcuts |
| User expects paste-on-release | Clear first-run signal; easy mode toggle |

## Open questions (recommended defaults)

| Question | Recommendation |
|----------|----------------|
| Shipping default mode? | Dogfood `stack` on branch; ship default after a week of use |
| Which cleanup timing ships? | Keep live whole-turn cleanup and commit-only whole-turn cleanup while dogfooding |
| Capture target at first fragment? | **No** in v1; focus at commit |
| Discard hotkey in v1? | Tray + optional hotkey |
| Show full turn text on overlay? | Truncated last fragment + fragment count |
| Empty fragment (no speech)? | Error flash; do not create empty turn |
| Should commit use repaste pipeline for “last text”? | Commit clears open; last committed remains repasteable via history |

## Success metrics (personal dogfood)

- Fewer manual seam/case fixes per agent turn.
- Ability to build a multi-fragment prompt without looking at the field until commit.
- No increase in “lost text” incidents (paste fail keeps buffer).
- Subjective: speech → agent feels continuous, not chopped by UI.

## Summary

Build a main-process **open turn buffer**: PTT stores raw fragments and a current
display snapshot; configurable cleanup timing determines when the whole
turn is regenerated. **Commit** publishes once. Caret reading stays out of the
stack-mode critical path.
