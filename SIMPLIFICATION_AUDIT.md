# Undertone simplification audit

Date: 2026-08-10  
Scope: application, renderer/preloads, native host, local runtimes/installers, tests, build, and release tooling  
Status: implemented; retained as the evidence and rationale record

## Bottom line

Undertone's core architecture is sound: one ordered dictation pipeline, a native Windows boundary for input/focus/paste/secrets/processes, and an in-memory raw turn are the right constraints. The codebase is not broadly full of junk.

The avoidable complexity is concentrated in five places:

1. The shipped app contains a Git-worktree build/hot-swap system that is unrelated to dictation and contributes more than 1,000 integrated lines.
2. Configuration pretends to become trusted, typed data without actually validating most fields. That causes crashes, wrong behavior, and defensive code everywhere downstream.
3. Several safety and lifecycle paths encode required behavior indirectly, especially auto-commit target failure and local-runtime state.
4. Test/demo machinery is embedded in production, most notably the fake settings backend in the renderer.
5. A handful of duplicated state machines and policies have already diverged and caused observable bugs.

My recommended direction is: fix the safety/correctness issues first, delete the shipped developer hot-swap feature, make config parsing a real boundary, move preview fixtures out of production, and then simplify the local-runtime and UI state models.

## Implementation outcome

The approved findings were implemented. The resulting production and tooling tree is 218 net lines smaller even after adding explicit local-artifact receipts, crash recovery, stricter native focus state, and bounded logging. Regression coverage grew by 1,463 net test lines.

The largest outcomes are:

- The shipped developer build/hot-swap manager and its integrated main-process paths are gone.
- Persisted config is exhaustively normalized once; hidden model overrides and downstream unknown-value handling are gone.
- Automatic paste targets, focus degradation, input mode, cleanup outcomes, and feedback destinations are explicit typed states rather than sentinels, wildcards, null overloading, or English-string matching.
- Local installation has pinned component plans, atomic receipts, staged validation, crash recovery, honest disk estimates, and one installed-state authority. Runtime use has liveness-checked callback ownership and cannot be ejected mid-request.
- Clipboard restoration, OAuth credential races, audio resource ownership, queue ordering, retry-audio ownership, and blank-turn behavior have focused regression tests.
- Preview fixtures no longer ship in the renderer; hidden settings windows do less work; release CI verifies, packages once, smoke-tests, and publishes the same artifacts.

The proposed full capture-registry rewrite was deliberately closed after re-audit. The remaining capture collections own different resources and lifetimes, and combining them would add lifecycle states without demonstrated net deletion or adequate characterization coverage. The smaller wire, preload, sizing, timing, and semantic-feedback cuts were made instead.

## Priority register

| ID | Priority | Recommendation | Value | Effort |
|---|---|---|---|---|
| A01 | P1 | Make failed auto-target capture explicit and remove archive work from the host command lane | High invariant clarity/responsiveness | M |
| A02 | P0 | Make config normalization exhaustive and trusted | Critical correctness; large simplification | M |
| A03 | P1 | Preserve the true clipboard baseline across rapid pastes, including an empty clipboard | High correctness | S |
| A04 | P1 | Unify local-runtime readiness/liveness/usage ownership | High correctness; medium simplification | M |
| A05 | P1 | Make installed local artifacts manifest-driven; delete CUDA double-counting | High correctness; high simplification | M |
| A06 | P1 | Stop treating every config read failure as first run | High data safety | S/M |
| A07 | P1 | Apply dictionary corrections exactly once | High deterministic behavior | S |
| A08 | P1 | Validate a full settings patch before external side effects | High state consistency | S/M |
| A09 | P1 | Prevent OAuth refresh from undoing disconnect | High state/security consistency | S |
| A10 | P1 | Consolidate microphone acquisition and keep cues off the capture queue | High audio correctness | M |
| A11 | P1 | Reject blank transcripts/cleanup before they enter the turn buffer | Medium-high correctness | S |
| A12 | P2 | Stop re-paste from creating a new History entry | Medium correctness | XS |
| A13 | P2 | Make UI Automation degradation explicit/recoverable | Medium focus-safety resilience | M |
| D01 | Decision | Delete shipped developer hot-swap; use a dev-only launcher | Very high deletion | M |
| D02 | Decision | Move fake settings backend into a capture-only preload | High deletion | S/M |
| D03 | Decision | Delete hidden cloud model overrides | Medium-high deletion | M |
| D04 | Decision | Delete failed-audio retry, or at least stop cloning WAVs through snapshots | Medium deletion/privacy/memory | S/M |
| S01 | P2 | Replace permanent full settings/history polling with invalidation/on-show refresh | Medium simplification/performance | M |
| S02 | P2 | Collapse parallel capture/draft state and trim its wire model | High maintainability | L |
| S03 | P2 | Define provider/config types once and keep internal APIs strictly typed | High maintainability | M |
| S04 | P2 | Give cleanup one error contract | Medium simplification | S/M |
| S05 | P2 | Analyze shortcut conflicts once; make overlay routing semantic | Medium simplification | M |
| S06 | P2 | Trim dead/native protocol surface and make process status atomic | Medium simplification/correctness | M |
| S07 | P2 | Build once in release, smoke the artifact, and verify tag/version | Medium release reliability | S/M |
| S08 | P2 | Make test commands self-contained or honestly split unit/integration tests | Medium developer reliability | S |
| S09 | P3 | Apply the proven small deletion bundle | Low risk cleanup | S |

P0 means the current path can violate a product invariant. P1 is a real bug or data/lifecycle risk. P2 is a meaningful simplification or lower-frequency defect. P3 is safe cleanup.

## Fix first

### A01 — Auto-target failure is represented by an opaque invalid target

Evidence:

- The native host reads and handles commands synchronously in `electron/native/Undertone.WinHost/Program.cs:108-126`.
- Archive extraction runs inline on that lane at `Program.cs:250-260` and `ArchiveInstaller.cs:21-55`.
- Local installation does not pause input at `electron/src/main/main.ts:1814-1838`.
- A foreground request times out in `electron/src/platform/windowsHost.ts:279-301`; `captureForegroundTarget` converts every error into `null` at `main.ts:721-732`.
- Main replaces that `null` with the sentinel `{ window: "0", generation: "-1" }` at `main.ts:897-904`. Native guarded validation rejects it, so the production automatic path keeps the turn open rather than pasting.
- The runner API still accepts `completion: "commit"` with a `null` target at `electron/src/core/dictationRunner.ts:53-59,80-85,192-197`; such a caller would select ordinary `sendPaste()`.

Why this is bad: the current production caller preserves the safety invariant, but only through a magic target that looks structurally valid. The core API still represents the unsafe combination, and extraction or host delays unnecessarily turn automatic commits into focus failures.

Action:

1. Replace the sentinel with an explicit automatic-target result. Make the automatic completion type require either a real guarded target or `unavailable`; `unavailable` keeps the turn open without attempting paste. Manual commit remains a separate unguarded method.
2. Move extraction off the latency-critical resident command lane, either to a worker inside the host or a separate one-shot native operation.
3. Do not expose fake cancellation: the current 300-second JS timeout only abandons the response; it does not stop native extraction (`windowsHost.ts:235-249,290-294`). Give extraction real completion/cancellation semantics or remove that timeout.

### A02 — `UndertoneConfig` is not actually trustworthy

Evidence:

- `UndertoneConfig` extends `Record<string, unknown>` at `electron/src/core/config.ts:5-7`.
- `normalizeConfig` copies recognized raw values without validating their declared type at `config.ts:89-96`, repairs only a subset, then casts at line 136.
- Consumers call `.trim()` and spread values as though validation were exhaustive at `electron/src/core/settingsModel.ts:108-119`.
- Reproduction: `normalizeConfig({ vocabulary: 42 })` makes `settingsSnapshot` throw `config.vocabulary is not iterable`; an array OAuth token throws on `.trim()`; `ai_cleanup: "false"` stays truthy.
- Defensive normalizers recur in `textPreparation.ts:41-45,67-79`, `dictationRunner.ts:60-69,245-263`, and `main.ts:2330-2359`.

Action: parse every known field once at the disk/IPC boundary and construct a real `UndertoneConfig`. Remove the index signature, final cast, double container clone (`config.ts:90,96,167-176`), and downstream coercion helpers. Unknown input belongs only at JSON and IPC boundaries.

This should be done before the provider/type and vocabulary simplifications in S03.

### A03 — Clipboard restoration loses the original value

Evidence:

- Each paste captures whatever is currently on the clipboard at `electron/src/core/clipboardPaster.ts:37-44`.
- A newer paste invalidates the older scheduled restoration at lines 61-69, then restores the first dictated text rather than the original clipboard.
- `electron/tests/clipboard-paster.test.ts:32` currently codifies the wrong final value.
- Line 60 deliberately skips restoring a previously empty clipboard.

Action: retain one original baseline for an overlapping paste burst and let the newest restoration restore that baseline. Remove the empty-string exception. Keep generation invalidation only for genuine external clipboard changes/fallback ownership.

### A04 — Local runtime has multiple, inconsistent definitions of “alive” and “in use”

Evidence:

- `LocalServerRuntime.status()` and `baseUrl()` trust cached `active` without checking the process at `electron/src/main/localRuntime.ts:89-109`.
- STT uses `ensureReady()` and checks native process liveness at lines 125-129; local cleanup uses the weaker synchronous `baseUrl()` path at `electron/src/core/cleanup.ts:98-105`.
- A crashed cleanup server therefore remains “loaded,” keeps returning a dead URL, and does not warm again.
- Idle eviction records request start, not request completion (`localRuntime.ts:105-109,246-260`), while inference happens afterward. A long request can be killed as “idle.”

Action: delete the weaker `baseUrl/loadAsync` ownership split. Use one runtime lease/readiness API for both engines: it must verify cached liveness, support non-blocking cold-cleanup fallback, count active requests, and arm idle eviction only after the last lease releases.

### A05 — Local installation has duplicated and shallow truth

Evidence:

- Install size/status/skip decisions mostly check one filename at `electron/src/main/localInstaller.ts:117-143,254-280`.
- Runtime readiness has a separate file list at `electron/src/main/localRuntime.ts:89-92,280-284,313-316`.
- Artifact hashes are checked only during download (`localInstaller.ts:288-349`); no installed version/hash manifest exists.
- `installSize()` already includes missing CUDA downloads at lines 120-142, but `prepare()` calculates and adds the same bytes again at lines 234-245.

Why this is bad: corrupt, incomplete, or old same-named artifacts are treated as installed, while valid NVIDIA installs can be rejected for roughly 640-678 MB of nonexistent extra space.

Action: define one declarative install plan per engine and persist a small manifest of pinned artifact identities after successful installation. Derive missing bytes, install steps, and runtime validation from that plan. Immediately delete `pendingCudaBytes` from the free-space calculation.

### A06 — Config read failures silently become defaults

`electron/src/main/configStore.ts:34-39` catches missing files, malformed JSON, permission failures, and transient I/O identically. Startup accepts the defaults, and a later save can overwrite a recoverable config.

Action: treat only `ENOENT` as first run. Preserve/rename invalid JSON and surface a recovery error; propagate other I/O failures. Replace the test that blesses silent corrupt-file fallback (`electron/tests/config.test.ts:138-145`).

### A07 — Dictionary corrections run twice only on successful AI cleanup

`electron/src/core/textPreparation.ts:47` applies corrections before cleanup, then line 57 applies them again through `finalizeTranscript`; the fallback path at line 60 applies them once. A map `{foo: "bar", bar: "baz"}` yields `bar` with one pass and `baz` with two.

Action: send raw transcript plus dictionary to cleanup, choose cleaned or fallback text, then apply deterministic corrections once.

### A08 — Settings side effects happen before full validation

`startWithWindows` is validated and discarded in `electron/src/core/settingsModel.ts:170-172`. Main validates it again and changes Windows/in-memory state at `electron/src/main/main.ts:1648-1656`, before the rest of the patch is validated and saved at lines 1657-1658.

Action: parse the entire patch into `{ nextConfig, platformChanges }` first. Only then persist/apply effects, with rollback where needed. Delete the duplicate no-op validation. A separate autostart IPC action is even simpler if combined settings transactions are not valuable.

### A09 — Disconnect can be undone by an in-flight OAuth refresh

`electron/src/main/openAiSubscription.ts:64-67` clears credentials, but a refresh that captured the old credentials at lines 170-175 can later persist and reinstall them at lines 185-188.

Action: give credential mutations one owner/generation. Disconnect and disposal invalidate/cancel refresh; refresh commits only if its generation remains current.

### A10 — Audio setup is duplicated and can leak resources; cues delay capture commands

Evidence:

- Dictation and microphone test separately acquire devices at `electron/src/renderer/audio/audio.ts:89-102,156-165`, using different signal-processing constraints.
- Failures after stream acquisition but before session/cleanup ownership is established can leak tracks or an `AudioContext`.
- All commands share one `operations` chain at lines 29-51. `cue` waits through context creation/playback/timeout/close at lines 60-77, so start/stop can sit behind roughly 135-190 ms of cue work.

Action: create one `openInput` helper with identical constraints and immediate `try/finally` resource ownership. Keep capture state changes serialized, but play cues independently through a reusable audio context.

### A11 — Blank input can create a phantom open turn

`dictationRunner.ts:87` rejects only `length === 0`; `turnBuffer.rawText()` trims to `null`, but the runner reintroduces the original whitespace at `dictationRunner.ts:155`. `TurnBuffer.append()` accepts an empty display string, after which `snapshot()` reports work while `peekText()` cannot commit it.

Action: reject `transcript.trim().length === 0`, treat blank cleanup output as cleanup failure for nonblank input, and forbid empty fragments in `TurnBuffer`.

### A12 — Re-paste creates fake dictation history

`electron/src/main/main.ts:1486-1489` pastes an existing entry and then registers it as a new success, duplicating History and evicting real entries.

Action: delete `history.registerSuccess(text)` from the re-paste handler.

### A13 — One hung UI Automation call silently degrades all future focus identity reads

`electron/native/Undertone.WinHost/FocusReader.cs:15-37` leaves `_busy` true after timeout until the blocked worker returns; `EnsureWorker` refuses replacement while it remains alive at lines 49-63. Every later query returns `null`, quietly reducing focus identity validation.

Action: make degraded focus identity an explicit state and either recover with a replaceable worker boundary or block the cases that require identity. Do not pretend each later query performed a fresh UIA check.

## Product decisions with large deletion payoff

### D01 — Delete the shipped developer hot-swap subsystem — recommended: yes

Evidence and scope:

- `electron/src/main/developerController.ts` is 717 lines.
- `main.ts:1095-1370` adds repository discovery, warnings, tray controls, build activation, and production/dev handoff; more managed-dev state/lifecycle exists at `main.ts:98-108,184-193,1546-1572,1768-1778,2203-2218`.
- It runs `npm ci`, builds worktrees, copies/symlinks app trees, supervises secondary Electron instances, copies production config, pauses production input, and manages rollback.
- Normal packaged production initializes it (`main.ts:1321-1369`) and always exposes a Development tray submenu (`main.ts:1303-1307`).

Why delete it: this is a personal development convenience embedded in the shipped dictation product. It owns over 1,000 lines across product lifecycle, expands attack/maintenance surface, and is already replaceable with `run.bat` plus a dev-only launcher script.

Delete the controller, tests, tray integration, `undertoneDevProtocol`, managed-dev environment/CLI branches, and dependency-stamp machinery that becomes unused. Keep only native process supervision required by local engines. Do not merely split the same system into more production files.

### D02 — Move the fake settings backend out of production — recommended: yes

`electron/src/renderer/renderer.tsx:1111-1287` ships about 177 lines of fake state, model selection, delayed installs, shortcut capture, history, and update behavior. It includes two hard-coded release versions. `electron/scripts/capture-settings.cjs:21-56` then implements a custom HTTP server solely so this fallback activates.

Action: put a fixed `SettingsApi` fixture in a capture-only preload and use `loadFile`. Delete `settingsApiForRenderer`, preview model derivation/imports, the custom server, and manual preview-version synchronization. This removes more than 200 lines from production/test plumbing.

Also delete `SettingsSnapshot.preview`; it is populated but never read in production (`electron/src/shared/settings.ts:50-79`, `settingsModel.ts:64-100`).

### D03 — Delete hidden cloud model overrides — recommended: yes unless manual config editing is an intentional feature

`stt_models`, `cleanup_models`, and `modelOverride` exist in `electron/src/core/config.ts:20-23,97-100,157-165`, but `SettingsPatch` and the renderer provide no way to change them. Tests explicitly describe them as config-only.

Action: use the pinned defaults in `electron/src/shared/models.ts` directly and delete the maps/lookup/repair branches. Then reassess response-format probing in `cleanup.ts:118-169,236-245` against the now-known supported models. If overrides are retained, expose and strictly validate them; the current half-feature is the worst option.

### D04 — Decide whether failed-audio retry earns its cost — recommended: retain only if it is used

The feature retains raw voice audio in memory and copies it repeatedly:

- storage and ignored return copy: `electron/src/core/pipelineQueue.ts:186-202`;
- full WAV cloning in `snapshot()`: lines 222-234;
- UI immediately discards bytes at `main.ts:1846-1862`;
- lookup clones every retained WAV at `main.ts:1872`;
- enqueue/dispatch copy again at `pipelineQueue.ts:63,109,138-145`.

Best deletion: remove failed-audio retry, its queue variant, WAV history field, IPC action, and UI. If retained, make registration return `void`, expose metadata-only snapshots/direct ID lookup, and transfer one owned buffer from History to queue to runner without further slicing.

## Second-pass simplifications

### S01 — Stop polling the entire settings app forever

`electron/src/renderer/renderer.tsx:40-55` fetches both settings and full History every second. The window is hidden rather than destroyed (`main.ts:1752-1760`), so polling persists after first open. Fresh objects rerender the entire settings app and trigger the WAV-cloning path described in D04. This polling is also the implicit transport for local-install progress, so removing it without a replacement would regress visible progress.

Use initial/on-show refresh plus narrow invalidation events. Give long local installs an explicit typed progress event; use a general settings/history invalidation for ordinary mutations. At minimum, pause polling on `visibilitychange` and load History only while that section is active.

### S02 — Give capture and turn-draft state one owner

`main.ts` tracks pending audio finalizations, live captures, active capture IDs, draft signals, dismissal state, manual-processing state, and several view flags separately (`main.ts:203-258`). `publishTurnDraft` reconstructs one view at lines 479-537, while captures are removed from many paths.

Replace the parallel maps/set/flags with one per-capture record plus one turn-presentation state and explicit transitions. Derive the view instead of manually synchronizing collections.

While doing that, trim the wire contract:

- `TurnDraftView.fragmentCount` and `charCount` are not consumed by the renderer.
- `liveState` is redundant after main derives `activity`.
- The renderer weakens required shared fields into a second optional `ActivityView` type and casts (`electron/src/renderer/turn-draft/turnDraft.ts:4-19,195-203`).
- Dead dataset fields can be removed.

Do not remove raw fragments from `TurnBuffer`; they are required by full-turn cleanup and scratch.

### S03 — Define provider/config truth once

Provider and cleanup-strategy unions are duplicated between `electron/src/core/config.ts:1-4` and `electron/src/shared/settings.ts:1-17`. Provider sets/guards recur in `settingsModel.ts:55-63`, `config.ts:139-145`, and `transcriber.ts:228-230`. Internal requests widen valid values back to optional strings and `unknown[]`, then normalize again.

Define canonical ID tuples once, derive unions/sets, and make transcription/cleanup request fields required and precise. Use one `xaiVocabularyHints(config): string[]` helper for batch (`dictationRunner.ts:245-253`) and live (`main.ts:2343-2351`). Keep `unknown` only at boundaries.

### S04 — Give cleanup one error contract

`CleanupClient.cleanup()` mixes `string | null` with a `throwOnError` flag used only by provider testing (`electron/src/core/cleanup.ts:55,75-94,157-213`; `main.ts:1935-1946`).

Make real failures throw one typed error. Reserve a distinct result only for the intentional cold-local fallback. `prepareText` catches normal cleanup failures and records fallback; provider testing naturally surfaces the same error. Delete `throwOnError` and repeated conditional rethrow machinery.

### S05 — Own each policy once

- Shortcut conflict scans are duplicated inside `settingsModel.ts:372-445`. Build one structured conflict analyzer; validation rejects conflicts involving changed fields and snapshots only format its result.
- Overlay duration defaults exist in `overlayController.ts:24-27,94-97` but main overrides them with different values at `main.ts:575-583`. Let the controller own defaults.
- Presentation routing matches exact English strings in `electron/src/shared/overlay.ts:51-54` and `main.ts:588-619`. Use a semantic outcome/destination or delete the special route.
- `TurnBuffer` stores current text both on `OpenTurn` and the last fragment (`turnBuffer.ts:7-10,67-71,84-101`). Delete `OpenTurn.text` and derive it.

### S06 — Trim and tighten the native/platform surface

High-confidence cuts:

- Delete the unused HTTP GET abstraction in `electron/src/platform/http.ts:7-10,21-37`; every consumer uses POST.
- Stop serializing mouse event payloads. No production listener calls `WindowsHost.onMouse`; keep only mouse-down generation increments required for focus safety (`Program.cs:427-455`, `windowsHost.ts:26-31,121-124`).
- Delete unused keyboard `scanCode`/`extended` transport fields; main consumes only event type, virtual key, and injected state.
- Make guarded paste targets required end-to-end. Production always supplies window/focus/identity/generation, while optional TS fields and native wildcard branches permit weaker future calls (`clipboardPaster.ts:11-16`, `windowsHost.ts:166-171`, `Program.cs:317-330`).
- Replace four input commands plus two booleans with `setInputMode("off" | "listen" | "shortcut-capture")` (`windowsHost.ts:126-140`, `Program.cs:143-164`).
- Make process status one locked native snapshot. It currently reads exit code and running separately (`Program.cs:239-248`, `ProcessSupervisor.cs:142-195`), which produces `{running:false, exitCode:null}` races and forces polling workarounds.

Keep input hooks, focus inspection, DPAPI, guarded paste, archive extraction, and child supervision in the native host. Their ownership is correct; their multiplexing and contracts need trimming.

### S07 — Build and test one release artifact

`.github/workflows/release.yml:25-26` runs `verify` and then `release`; both build. The published package is therefore not the exact build verified moments earlier, and neither package smoke runs.

Build once, run source tests, package once, smoke that package, then publish the tested artifact. Assert that the pushed tag matches `electron/package.json` before expensive work. Add ordinary push/PR verification rather than first verifying in automation after a release tag.

### S08 — Make commands honest about prerequisites

`npm test` runs Windows-host tests that resolve `dist/native/Undertone.WinHost.exe`, but its script does not build the host. `test:turn-draft-native` runs only TypeScript/Vite. Both can fail on a clean checkout while passing after `npm run build`.

Either make commands self-contained or split pure unit tests from built-host integration tests and name/document both. Use the normal build for the native draft test instead of a misleading partial build.

`build.bat` should also not treat the presence of Electron's executable as proof that dependencies match the lockfile. Use the same dependency-readiness policy as `run.bat`; an unconditional `npm ci` is simplest for release builds.

### S09 — Safe small deletion bundle

These have proven no callers or are redundant under current configuration:

- `package:nsis` duplicates `package` because NSIS is the only configured Windows target (`electron/package.json:17-18,80-82`).
- `electron/vitest.config.mts` only restates Vitest's default test glob; remove the config flag/include. All tests import Vitest explicitly, so remove `vitest/globals` from `tsconfig.json` too.
- `exclude: ["tests/**/*.ts"]` in `tsconfig.build.json` is redundant with its source-only `include`.
- Remove unnecessary exports for internal-only declarations such as `LocalBuild`, `LocalRuntimeOptions`, history entry types, `DEFAULT_TAP_MS`, and `encodePcm16`; enable `noUnusedLocals` and `noUnusedParameters` in `tsconfig.json` (the code already passes both flags).
- Delete dead renderer/CSS hooks: `localPolicy`, `speechColumns`, `.historyEntry small`, unused History wrapper markup, and unused turn-draft dataset/probe fields.
- Make settings capture fail when the horizontal-overflow metrics it already computes are true (`electron/scripts/capture-settings.cjs:69-87,121`).
- Move local model filenames to one source of truth; they are duplicated between `shared/models.ts` and `main/localRuntime.ts`.
- Create the log directory once and bound/rotate `app.log`; consider persisting only warnings/errors instead of globally intercepting every console method (`electron/src/main/fileLog.ts:16-34`).

## Recommended execution order

1. **Invariant patch:** A01, A03, A07, A09, A11, and A12. These are narrow and should not wait for refactors.
2. **Configuration boundary:** A02, A06, A08, then S03/S04. This deletes defensive code safely because the boundary becomes trustworthy first.
3. **Large deletions:** D01 and D02. Re-run the full baseline before doing other structural work; these removals simplify later native/main/renderer changes.
4. **Local engine lifecycle:** A04, A05, and the event-driven progress part of S01. Treat install truth, runtime liveness, leases, and UI status as one coherent project.
5. **Audio/focus resilience:** A10 and A13.
6. **State/protocol simplification:** S01, S02, S05, and S06. Avoid mixing this with the invariant fixes.
7. **Tooling cleanup:** S07-S09 and the D04 decision.

## Guardrails: complexity that is justified

- Keep one ordered FIFO pipeline and snapshot config when each job starts. Its implementation can shrink, but ordering must remain explicit.
- Keep raw open-turn fragments. Delete only duplicated current display state.
- Keep OS input, focus validation, guarded paste, secret protection, archive extraction, and process supervision native.
- Keep local cleanup non-blocking on cold load; unifying runtime APIs must preserve deterministic fallback.
- Never simplify automatic commit into ordinary unguarded paste.

## Validation performed

- `npm ci`: successful; 0 reported vulnerabilities.
- `npm run verify`: successful.
- TypeScript typecheck and native/renderer builds: successful.
- Tests: 23 files passed; 167 tests passed, 4 skipped.
- `tsc --noEmit --noUnusedLocals --noUnusedParameters`: successful.
- No tracked generated outputs or unused direct npm dependencies were found.
- The config crashes and double-correction behavior described above were reproduced against the built code.
- The automatic target-failure path was rechecked after the audit: the production caller currently fails closed through an invalid guarded-target sentinel; the audit text above reflects that correction.
