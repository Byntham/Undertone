# Session turn buffer

**Branch / worktree:** `feat/session-turn-buffer`  
**Status:** phase 2 polish (scratch last, richer overlay); dogfood continues  
**Decision:** utterance = **fragment of a turn** — release stacks; commit sends.

## Problem

Undertone formats by reading caret context (UIA → Win32 → insertion memory). Many targets expose no text, so seams and cleanup degrade and force manual repair. Repair is non-contributing input: it burns bandwidth between mind and agents.

North star: maximize trusted intent throughput into AI, with minimal eyes-on-field and minimal edit tax.

## Product decision

Undertone **owns the open turn**. Each dictate appends a fragment to a session buffer. Formatting always uses that buffer as left context. Nothing is injected into the foreign app until an explicit **commit**.

```text
hold PTT → speak fragment → release
        → STT → cleanup against buffer tail → append fragment
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

### Fragment join

Fragments are joined with the same seam rules used today (`finalize` / cleanup), but **left context is always the current open-turn text** (tail), not the OS caret.

Recommended join policy:

- Run `prepareText` per fragment with `before = openTurnText`, `after = null` (right side unknown until commit into a real field; acceptable for agent turns).
- Append the prepared fragment to the open turn (string concatenation of prepared pieces; do not re-prepare the whole turn each time unless cleanup quality requires it — see open questions).
- On commit, paste `openTurnText` as a single string (optional final pass: light trim only; avoid double AI cleanup of the whole turn in v1 unless tests show need).

## Data model

```ts
interface TurnFragment {
  id: string;
  raw: string;          // post-correction, pre-prepare (for debug / retry)
  text: string;         // prepared fragment text actually appended
  createdAt: number;
}

interface OpenTurn {
  id: string;
  fragments: TurnFragment[];
  /** Joined prepared text; source of truth for context + commit body */
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
- `open.text === join(fragments.map(f => f.text))` under the append rules (store `text` denormalized for O(1) tail context).
- Password fields: never read caret (unchanged). Commit still pastes if user commits while focused there — same as today; reading remains forbidden.
- Main process owns the buffer (single-writer, same as dictation queue).

Persistence (v1): **in-memory only**. Survive app restart empty. Optional later: `%APPDATA%` draft if crash mid-turn proves painful.

## Lifecycle

### Start turn

Implicit: first successful fragment while `open === null` creates `OpenTurn`.

### Append fragment

On successful STT (non-empty):

1. `before = open?.text ?? ""` (empty string is real context: start of turn).
2. `prepareText(transcript, config, { before, after: null })` — **do not** call native caret for stack-mode formatting (or call only as non-blocking telemetry later).
3. Append fragment; update `open.text`.
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

Remove last fragment and rebuild `open.text` from remaining fragments (store per-fragment `text` makes this easy). Voice “scratch that” later.

### Idle policy

If open turn sits idle for `turn_idle_minutes` (default **15**): auto-discard or soft-warn then discard. Prefer **discard with a warning flash** once so stale context doesn’t poison the next agent ask.

### Invalidation

Do **not** clear the open turn on arbitrary key/mouse in the foreign app (unlike insertion memory). The buffer is ours; external typing does not edit it.

Clear only on: commit success, discard, idle timeout, mode switch away (configurable), app quit.

## Modes

| Mode | Release behavior | Commit |
|------|------------------|--------|
| **stack** (default for this work) | Append to open turn | Required to paste |
| **instant** | prepare + paste immediately (today); still may record to a side journal later | N/A |

v1 settings:

- `dictation_mode: "stack" | "instant"` (config key TBD; default `"stack"` for the feature branch experiment, or default `"instant"` until stable — **recommendation:** default `"stack"` on the feature branch, decide shipping default after dogfood).

Instant mode preserves current muscle memory for search boxes and one-liners.

## Gestures

| Action | Proposed default | Notes |
|--------|------------------|-------|
| Dictate fragment | existing `hotkey` (PTT) | Unchanged |
| Commit turn | new `commit_hotkey` e.g. `ctrl+alt+enter` | Must not conflict with PTT |
| Discard turn | new `discard_hotkey` or tray-only in v1 | Tray-only is OK for v1 to reduce binding sprawl |
| Repaste last **committed** | existing `repaste_hotkey` | Unchanged; does not commit open turn |
| Scratch last fragment | defer | |

Commit must work when the agent field is focused; it must **not** require focusing Undertone.

## UI / overlay

Overlay remains non-focusable (invariant).

| State | Overlay idea |
|-------|----------------|
| Recording / transcribing | unchanged |
| Fragment stacked | success pulse + short preview of fragment, or `Turn · 3` / char count |
| Open turn waiting | optional subtle idle badge while `open` non-null (avoid nagging) |
| Commit success | brief success, then hide |
| Commit fail | warning + clipboard message |
| Discard | brief “Turn discarded” |

Optional later: hotkey opens a **read-only or light-edit** turn panel (focus only when user asks). Not required for v1 dogfood if overlay + commit are solid.

## Formatting pipeline changes

Today (`prepareText`):

1. Optionally acquire caret / insertion memory.
2. AI cleanup with `text_before_cursor = before`.
3. `finalize` with before/after seams.

Stack mode:

1. `before = openTurn.text` (or `""`).
2. `after = null`.
3. Same cleanup + finalize.
4. Append; no paste.

Caret / insertion memory: **skipped for stack-mode prepare**. Insertion memory still updates **on commit** with the full turn (helps instant mode and any future hybrid).

Left-only-to-AI rule unchanged: only buffer tail is sent to cleanup, never OS right-side text.

## Integration with existing architecture

```text
PTT release → audio → queue job
                 ↓
         DictationJobRunner (stack branch)
                 ↓
         STT → corrections → prepare(before=buffer) → TurnBuffer.append
                 ↓
         overlay success (no paster.paste)

commit hotkey → queue commit job (ordered with dictation queue)
                 ↓
         paste(open.text) → history → insertionMemory → clear open
```

Use the **single dictation queue** so commit cannot race mid-append. Commit enqueues like repaste.

Focus restore: on **commit**, reuse dictation target capture rules. Options:

- **A.** Capture foreground at commit time (simple; user focuses agent then commits).
- **B.** Capture target at first fragment of the turn and restore on commit.

**Recommendation:** A for v1 (user is already focusing the agent when ready to send). B is a nicety if commit happens while user glanced elsewhere.

## Privacy

- Open turn lives in main process memory; not sent anywhere except:
  - cleanup provider (fragment + tail context, as today’s left context),
  - STT provider (audio / fragment only),
  - paste target on commit.
- Do not write open turns to disk in v1.
- History: log **committed** turns as today; optionally log fragments only in verbose debug.

## Testing plan

- Unit: append join; prepare uses buffer tail; commit pastes joined text; paste failure preserves turn; discard; idle clear; mode switch.
- Unit: stack mode never calls `getCaretContext`.
- Integration: queue ordering — fragment job then commit.
- Manual dogfood: multi-fragment agent prompt in Claude/Codex/chat; confirm zero caret dependency in Notepad with focus elsewhere during fragments.

## Implementation phases

### Phase 0 — this design (done when accepted)

### Phase 1 — core buffer + stack path

- `TurnBuffer` module in main/core.
- Config: `dictation_mode`, `commit_hotkey`, optional `turn_idle_minutes`.
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
| Double cleanup if re-prepare whole turn | v1 prepare per fragment only |
| Commit hotkey collision | Settings + conflict detection like existing shortcuts |
| User expects paste-on-release | Clear first-run signal; easy mode toggle |

## Open questions (recommended defaults)

| Question | Recommendation |
|----------|----------------|
| Shipping default mode? | Dogfood `stack` on branch; ship default after a week of use |
| Re-run AI cleanup on full turn at commit? | **No** in v1 |
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

Build a main-process **open turn buffer**: PTT stacks prepared fragments against buffer-owned context; **commit** publishes once. Caret reading leaves the critical path for stack mode. That is the first structural step toward higher mind→agent bandwidth with less repair.
