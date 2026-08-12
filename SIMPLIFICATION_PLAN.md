# Undertone simplification plan

Date: 2026-08-10  
Source: `SIMPLIFICATION_AUDIT.md`  
Status: implemented and verified

## Execution result

All approved correctness, deletion, boundary, native/local, UI, and tooling slices were completed. S02b was re-audited and closed: the proposed unified capture registry would not reduce state or branches because the remaining owners have intentionally different lifetimes.

Validation completed on the final tree:

- `npm run verify`: 24 test files, 219 passed, 3 opt-in tests skipped.
- Settings and overlay captures at 100%, 150%, and 200%; no horizontal overflow and representative images visually inspected.
- `npm run smoke:audio`.
- `npm run package`, `npm run smoke:package`, and `npm run smoke:package:local` against the packaged output.
- `git diff --check` and TypeScript unused-local/unused-parameter enforcement.

Desktop tests that intentionally steal focus or the mouse were not run in the active user session. Their non-interactive native coverage ran through `verify`.

## Decisions

The audit findings are mostly valid and worth addressing. The plan deliberately narrows several recommendations so simplification work does not become a new layer of architecture.

| ID | Disposition | Decision |
|---|---|---|
| A01 | Address in two parts | Replace the invalid-target sentinel now; isolate extraction later. The production path currently fails closed, so this is P1 rather than P0. |
| A02 | Address | Make persisted config a genuinely trusted boundary and delete downstream coercion. |
| A03 | Address | Preserve one clipboard baseline across overlapping pastes, including an empty baseline. |
| A04 | Address | Give local runtime use one liveness-checked callback/lease owner. |
| A05 | Address in two parts | Fix workspace estimation immediately, then introduce declarative artifact plans and atomic receipts. |
| A06 | Address with A02 | Missing, malformed, and unreadable config must have distinct outcomes. |
| A07 | Address now | Apply deterministic corrections exactly once. |
| A08 | Address with a simpler design | Remove autostart from the general config patch; give it one dedicated operation. |
| A09 | Address now | Generation-guard connect/refresh/disconnect/dispose. |
| A10 | Address | Share microphone resource ownership and decouple cue duration from capture commands. |
| A11 | Address now | Enforce nonblank input/prepared/buffer text. |
| A12 | Address now | Delete History registration from re-paste. |
| A13 | Address narrowly | Represent UIA degradation explicitly and fail closed; do not create a replaceable-thread farm. |
| D01 | Delete | Remove the shipped developer hot-swap system without recreating it elsewhere. |
| D02 | Delete from production | Keep a small capture-only fixture/preload. |
| D03 | Delete | Remove hidden model overrides before writing the final config parser. Keep provider response-format fallback. |
| D04 | Retain feature; replace implementation | Retry has clear recovery value. Delete WAV cloning and bound retained bytes. |
| S01 | Address narrowly | Poll only while visible; fetch History only on its section. Do not add an event bus yet. |
| S02 | Partially address, then re-audit | Delete dead wire/view state now. Defer the full capture registry rewrite until `main.ts` has materially shrunk. |
| S03 | Merge with A02/D03 | One provider/type source and strictly typed internal requests. |
| S04 | Address after A04 | One thrown failure contract plus one explicit local-cold result. |
| S05 | Address in small slices | Unify shortcut analysis, overlay timing, feedback destination, and turn text ownership. |
| S06 | Address after D01 | One native protocol revision for strict targets/input mode/dead payload cuts; delete exit-code machinery if no caller remains. |
| S07 | Address | Build once, smoke that package output, then publish those exact assets. |
| S08 | Address | Make direct test/native commands self-contained without adding a prerequisite framework. |
| S09 | Address selectively | Land proven deletions; treat logging retention as its own behavior change. |

## Planning correction to the audit

Automatic target capture failure does not currently cause an unguarded production paste. `main.ts:897-904` substitutes `{ window: "0", generation: "-1" }`; native guarded validation rejects it and the open turn is retained. The problems are:

- safety depends on a magic structurally-valid target;
- `DictationJobRunner` still permits `completion: "commit"` with `target: null`;
- synchronous resident-host extraction can unnecessarily cause foreground capture to time out.

The audit document has been corrected accordingly.

## Constraints for the work

- No new application runtime, state-machine library, event bus, schema package, or generic package manager.
- No full capture/draft rewrite until smaller deletions and fixes have landed.
- No repeated hashing of multi-gigabyte models at startup or during settings refresh.
- No recreation of the developer hot-swap feature in another form.
- No removal of FIFO ordering, raw turn fragments, guarded automatic paste, native OS ownership, or nonblocking cold local-cleanup fallback.
- Prefer a net deletion in every simplification change. If a cleanup adds more state/branches than it removes, stop and reassess.

## Phase 0 — Make verification commands honest

Do this first so every later change has reliable local and CI boundaries.

### 0.1 Test command model

Files: `electron/package.json`, `AGENTS.md`.

- Add `test:built` for plain Vitest execution.
- Make `npm test` run `build:native` and then `test:built`, so it works on a clean checkout.
- Make `verify` run `typecheck`, one full `build`, then `test:built`; it must not compile the host twice.
- Make `test:turn-draft-native` use the normal full build before its driver.
- Keep `run.bat`'s lightweight dependency check; make release-oriented `build.bat` run `npm ci` unconditionally.

This uses script composition rather than a new timestamp/prerequisite script.

Acceptance:

- After deleting `electron/dist`, `npm test` succeeds.
- `npm run verify` builds the native host exactly once.
- `npm run test:turn-draft-native` no longer depends on stale `dist/native` state.

## Phase 1 — Narrow correctness fixes

These are small, independent, and should land before structural work. Keep them as individually reviewable commits even if they share one PR.

### 1.1 Explicit automatic target failure — A01a

Files: `electron/src/main/main.ts`, `electron/src/core/dictationRunner.ts`, related runner tests.

- Delete the `{ window: "0", generation: "-1" }` sentinel.
- Represent automatic completion as a discriminated value with either a complete guarded target or `target: "unavailable"`.
- `unavailable` transcribes/appends the turn, reports focus validation failure, and never calls paste.
- Keep `DictationJobRunner.commit()` as the only targetless/manual paste path.

Tests must prove that automatic target failure retains the turn and never calls ordinary or guarded paste, while manual commit still pastes to current focus.

### 1.2 Clipboard burst ownership — A03

Files: `electron/src/core/clipboardPaster.ts`, `electron/tests/clipboard-paster.test.ts`.

- Track one original baseline while Undertone still owns the clipboard.
- Reuse that baseline when another paste starts before restoration.
- Treat `""` as a valid baseline; use a distinct unavailable state for read failure.
- If the user changes the clipboard between pastes, adopt that external value as the new baseline.
- Clear ownership after restoration, fallback copy, a non-restoring paste, or external replacement.

Required tests: rapid paste restores original, empty restores empty, external change wins, fallback invalidates pending restore.

### 1.3 One correction pass — A07

Files: `electron/src/core/textPreparation.ts`, `electron/tests/text-preparation.test.ts`.

- Send raw transcript plus dictionary to cleanup.
- Choose cleaned output or raw fallback.
- Run `finalizeTranscript` once after that choice.

The chained map `{foo: "bar", bar: "baz"}` must produce `bar` on both successful cleanup and fallback.

### 1.4 OAuth generation — A09

Files: `electron/src/main/openAiSubscription.ts`, subscription tests.

- Increment one session generation on credential replacement, disconnect, and dispose.
- Connect and refresh may persist/commit only while their captured generation is current.
- Disconnect invalidates async work before clearing/persisting credentials.
- Apply the guard to sign-in completion as well as token refresh.

Tests must hold an async connect/refresh, disconnect, release it, and prove credentials remain cleared.

### 1.5 Nonblank turns and single text ownership — A11 + part of S05

Files: `electron/src/core/dictationRunner.ts`, `textPreparation.ts`, `turnBuffer.ts`, related tests.

- Reject whitespace-only transcripts before preparation.
- Treat blank cleanup output for nonblank raw text as cleanup failure and use deterministic fallback.
- Reject blank raw/display text in `TurnBuffer.append` and blank replacement text.
- Delete `OpenTurn.text`; derive the current display text from the final fragment snapshot.

### 1.6 Re-paste and disk-estimator fixes — A12 + A05a

- Delete `history.registerSuccess(text)` from the re-paste handler.
- Replace the CUDA-specific duplicate free-space count with a named plan-derived estimate: missing download bytes + extraction workspace + fixed reserve. Do not simply subtract bytes without accounting for archive and staged-output coexistence.

Gate after Phase 1: `npm run verify` and focused config-free unit tests all pass. No protocol, config schema, or renderer API changes belong in this phase.

## Phase 2 — Delete non-product machinery

Do these before further work in `main.ts` and `renderer.tsx`.

### 2.1 Delete shipped developer hot-swap — D01

Delete:

- `electron/src/main/developerController.ts` and its tests;
- repository discovery, warnings, worktree tray UI, activation, build handoff, production pausing, and dev shutdown integration from `main.ts`;
- managed-dev CLI/environment/profile/ready-file branches;
- `undertoneDevProtocol`, the dependency-stamp postinstall, and `scripts/stamp-dependencies.mjs`;
- dev-only tooltips, asset paths, updater suppression, and settings forwarding.

Retain:

- `run.bat` as the source-development path;
- ordinary Electron preview isolation;
- native supervision required by local engines;
- smoke profiles and normal tray behavior.

Do not automatically delete old `%LOCALAPPDATA%\Undertone\DevBuilds`, `ManagedDev`, or `developer.json`. Mention them as optional manual cleanup because they may contain user-created trees/junctions.

After product deletion, remove native process environment injection and recheck process-status consumers. If only local runtimes remain, delete exit-code retention/status rather than repairing an API nobody needs.

Verification:

- `npm run verify`;
- `run.bat` source launch;
- tray Settings, pause/resume, and quit;
- `npm run package` and `npm run smoke:package`;
- installed updater initialization remains normal.

### 2.2 Move the settings fixture out of production — D02

Delete from production:

- `settingsApiForRenderer`, preview model derivation, fake state/actions/delays/history/update logic, and preview-only imports;
- `SettingsSnapshot.preview` and the `settingsSnapshot` preview parameter;
- two hard-coded version values and the manual release-sync requirement;
- the loopback HTTP server in `capture-settings.cjs`.

Replace with one small capture-only CJS preload under `electron/scripts` that exposes a static `SettingsApi`. `capture-settings.cjs` should use `loadFile` and read the version from `package.json`. The fixture should support only behavior needed by screenshots; it must not become a second implementation of settings business logic.

At the same time, make capture fail when its existing body/content horizontal-overflow metrics are true.

Verification: full verify plus settings captures at 100%, 150%, and 200% for all sections/secondary views.

### 2.3 Safe compiler/dead-code cuts — part of S09

After the large deletions:

- delete `package:nsis`;
- delete redundant `vitest.config.mts` and its references;
- remove `vitest/globals` and the redundant build test exclusion;
- enable `noUnusedLocals` and `noUnusedParameters`;
- remove unnecessary exports revealed by the stricter compiler;
- delete proven-unused renderer/CSS hooks and wrapper markup.

Do not mix log-retention behavior into this mechanical change.

## Phase 3 — Establish trusted configuration

Order matters: delete fields first, then write the final parser.

### 3.1 Delete hidden model overrides — D03

Delete `stt_models`, `cleanup_models`, `modelOverride`, repair branches, override tests, and model arguments threaded from config. Use the pinned defaults at the provider request boundary.

Retain:

- displayed active-model information;
- cleanup response-format fallback/probing, which still protects provider capability differences;
- local engine artifact model constants, moved to one source in `shared/models.ts`.

Old override keys are ignored and disappear on the next successful save. Do not implement a migration for an undocumented config-only feature.

During the later runtime phase, remove requested-model/path-override state from `LocalServerRuntime` rather than editing it twice here.

### 3.2 Safe config recovery — A06

Files: `electron/src/main/configStore.ts`, startup handling, config tests.

- Only `ENOENT` means first run.
- Parse JSON separately from reading.
- Rename malformed JSON to a timestamped `config.invalid-*.json`, return defaults with recovery metadata, and show/log the recovery path.
- Propagate permissions, directory, DPAPI, rename, and other I/O failures; show a clear fatal startup error rather than silently continuing.

The recovery file is the rollback path. Never overwrite it automatically.

### 3.3 Exhaustive parser and canonical provider truth — A02 + S03

- Define provider ID tuples/guards and cleanup strategy once.
- Make `UndertoneConfig` a closed interface with precise transcription and cleanup provider types.
- Replace copy-then-cast normalization with an explicit persisted-config parser that constructs every retained field.
- Persisted config remains forgiving per field: invalid values use that field's default, unknown keys are dropped, and intentional migrations such as `fast -> priority` remain.
- IPC patches remain strict and reject invalid input.
- Queue dequeue clones a known-valid config; it does not normalize trusted data again.
- Make internal transcription/cleanup options required and precisely typed.
- Add one `xaiVocabularyHints(config): string[]` used by live and batch paths.
- Delete `ConfigRecord`, the final cast, duplicate container clone, provider fallbacks, `Boolean(...)`, `stringValue`, `nonzeroNumber`, `isStringMap`, and internal `unknown[]` handling made impossible by the boundary.

Tests need an exhaustive malformed-field matrix, container isolation, unknown-key dropping, enum/range migrations, and the reproduced OAuth/vocabulary/boolean failures.

### 3.4 Isolate autostart — A08

- Remove `startWithWindows` from `SettingsPatch` and `applySettingsPatch`; keep it in the snapshot.
- Add one dedicated authorized `setStartWithWindows(enabled)` preload/IPC operation.
- Update in-memory state only after the registry operation succeeds.
- Serialize it with settings operations, but do not save an unchanged config file or invent a cross-resource transaction framework.

### 3.5 One shortcut analyzer — part of S05

After config types are trusted, replace duplicate conflict loops with one structured analyzer. Patch validation rejects conflicts involving changed fields; snapshot warnings format the same analyzer result. Preserve the ability to repair a legacy conflict one shortcut at a time.

Gate after Phase 3: `npm run verify`, config/settings/provider tests, and a manual malformed-config recovery check using a disposable profile.

## Phase 4 — Simplify the native and local-engine boundaries

Delete D01 first so this protocol revision does not preserve developer-only requirements.

### 4.1 One native protocol revision — A01b + A13 + S06

Bump the host protocol once and land TypeScript/native changes atomically.

- Move archive extraction to a one-shot mode of the existing `Undertone.WinHost.exe`; do not multiplex long extraction on the resident hook/focus host.
- The one-shot operation keeps staged promotion, can be killed on timeout/shutdown, and is awaited to exit. Delete the resident `extractSubset` command afterward.
- Replace four start/stop input/capture commands with `setInputMode("off" | "listen" | "shortcut-capture")` if the final diff is a net deletion.
- Make guarded targets fully required: window, focus (including literal `"0"`), focus-identity state/value, and input generation. Delete native wildcard branches.
- Distinguish UIA identity `available`, successfully `unavailable`, and `degraded`. Degraded capture or revalidation fails closed. Do not spawn replacement STA threads after a hung COM call.
- Stop emitting unused mouse payloads/listeners while retaining mouse-down input-generation increments.
- Remove unused keyboard scan-code/extended transport fields.
- Delete process environment injection left by D01.
- If no product caller needs exit codes after D01, delete exit-code storage/settlement/status and retain one atomic `isSupervisedRunning` result. Do not “fix” dead status detail.
- Delete the unused platform HTTP GET abstraction independently in this phase.

Tests: protocol validation, every input-mode transition, immediate process exit/unknown PID, strict focus combinations, degraded UIA behavior, extraction cancellation/staging, and existing desktop focus/paste E2E when the desktop is idle.

### 4.2 Declarative local artifacts and receipts — A05b

Create one small installation-plan module, not a generic package framework.

Per engine/component define:

- pinned source identity, size, and applicability (core/NVIDIA);
- direct-file or archive install action;
- target and expected outputs;
- conservative extraction workspace.

Use atomic per-component receipts written only after verified staged promotion. Current means receipt identity matches and required outputs exist; direct model size must match. Receipts prove provenance/completion, not permanent immunity to bit rot.

Migration:

- Adopt a legacy install only when every expected runtime output exists and model sizes match.
- Mark adoption as legacy provenance.
- Never force a multi-gigabyte redownload merely because the receipt feature is new.
- Malformed/stale receipts or missing outputs make only that component repairable, not the whole engine.

Make this artifact plan the one installation/readiness truth consumed by installer and runtime. Eject a running engine before repairing locked files.

### 4.3 Owned runtime use — A04

Replace raw URL ownership with a callback API such as `withServer(policy, callback)`:

- `wait` starts/waits for STT;
- `fallback` uses a live warm cleanup server, otherwise single-flight warms asynchronously and returns the intentional deterministic fallback;
- cached PID liveness is checked before callback use;
- active callback count cancels idle eviction;
- release happens in `finally` even when HTTP work throws;
- a full idle period begins only after the final active callback settles;
- explicit load/warm/eject remain for Settings and shutdown.

Remove requested-model state as part of D03 cleanup. Do not add a process-exit event unless callback liveness still leaves a demonstrated UI/status problem.

Tests: stale cleanup PID never receives a POST, STT restarts and waits, single-flight warm, overlapping/long inference survives the idle deadline, throwing callback releases, eject/shutdown during use, CUDA fallback, receipt readiness, and installed local-runtime E2Es.

Gate after Phase 4:

- `npm run verify`;
- Windows-host tests;
- `UNDERTONE_HOST_DESKTOP_E2E=1` on an idle desktop;
- applicable local runtime/installer E2Es;
- `npm run package`, `npm run smoke:package`, and `npm run smoke:package:local` where local engines are installed.

## Phase 5 — Cleanup, audio, History, and UI policy

### 5.1 One cleanup contract — S04

Land after runtime callbacks so local cleanup is only adapted once.

- All real cleanup failures throw one sanitized `CleanupError`.
- Remove `throwOnError`, conditional rethrow branches, and ordinary failure `null` values.
- Return a discriminated result only for successful cleaned text versus intentional `local-cold` fallback.
- `prepareText` catches cleanup failure, uses deterministic formatting, and marks `cleanupFailed`.
- Provider testing uses the same error path.

### 5.2 Audio ownership and cues — A10

In `renderer/audio/audio.ts`:

- add one `openInput(deviceName)` handle with identical raw mono constraints and idempotent cleanup;
- establish track/context ownership immediately after acquisition so partial setup failures cannot leak;
- use it for dictation and microphone test;
- keep capture state changes serialized;
- make cue playback nonblocking once its ordered command is reached;
- reuse one lazy cue context and close it on renderer unload.

Verify with `npm run smoke:audio`, rapid cancel/restart, and unavailable-device behavior.

### 5.3 Retain retry, delete WAV copying — D04

- `registerFailure` takes ownership and returns no copied entry.
- History snapshot is metadata-only and includes `retryable`; it never exposes WAV bytes.
- Add direct lookup/take operations; retry removes and transfers its one owned buffer.
- Queue and runner transfer that buffer without slicing.
- Keep at most three retryable failures and add one named total-byte cap based on encoded PCM rate. Do not add both per-record and total caps unless tests demonstrate a need.
- Oversized/old failures remain visible but non-retryable.

Tests must prove metadata contains no audio, retry consumes once, FIFO/open-turn behavior remains, and byte/count eviction is deterministic.

### 5.4 Narrow settings polling — S01

Do not add a settings event bus in this program of work.

- Refresh settings only while the window is visible.
- Refresh immediately on visibility return.
- Load/poll History only while the History section is active.
- Keep visible one-second refresh during a local install so progress remains visible.
- Action APIs continue returning updated snapshots, avoiding new push channels.

After D04, this polling no longer clones audio. Re-evaluate only if runtime status still needs push updates.

### 5.5 Small overlay/view ownership cuts — S05 + S02a

- Let `OverlayController` own default durations; remove main's second table.
- Replace exact-English-string presentation routing with an explicit small feedback destination/outcome value.
- Remove unused `TurnDraftView` wire fields only after confirming capture/CSS consumers: `charCount`, redundant `liveState`, and any truly unused fragment count.
- Delete the renderer's weaker optional duplicate view type/cast and dead dataset fields.
- Update overlay capture fixtures/tests.

Do not perform the full capture registry rewrite here.

Gate after Phase 5: full verify, audio smoke, Settings captures at 100/150/200%, overlay captures at 100/150/200%, and `test:turn-draft-native` on an idle desktop.

## Phase 6 — Release integrity and remaining mechanical cleanup

### 6.1 Build, smoke, and publish one artifact — S07

Package scripts:

- add `package:built` that packages existing verified `dist` without rebuilding;
- keep `package` self-contained as build + `package:built`;
- delete the current `release` footgun that rebuilds while publishing;
- explicitly clean `electron/release` before packaging to prevent stale uploads.

Release workflow:

1. Assert tag equals `v` + `package.json.version`.
2. `npm ci`.
3. `npm run verify` — one source/native/renderer build and all tests.
4. `npm run package:built` — package that exact verified `dist`.
5. Run the existing `smoke:package` against the generated `win-unpacked` output.
6. Create/update a draft GitHub release and upload the exact installer, blockmap, and `latest.yml` produced above.
7. Publish the release only after every asset upload succeeds.

Do not add installer install/uninstall automation in this simplification program; the existing package smoke covers the packaged app bits without adding a new destructive CI/local workflow. Revisit an installer lifecycle smoke separately if release failures justify it.

Add a normal Windows push/PR workflow running `npm ci` and `npm run verify`.

### 6.2 Logging and final S09 cuts

- Create the log directory once.
- Bound `app.log` with one small startup rotation/backup policy.
- Retain informational logging for now; removing it is not supported by the audit evidence.
- Finish internal export, duplicated constant, CSS, test-fixture, and config-file deletions that were intentionally folded into related phases.

Gate: clean checkout `npm ci`, `npm test`, `npm run verify`, `npm run package`, and `npm run smoke:package`. Confirm release asset hashes match the files that passed package smoke.

## Phase 7 — Re-audit capture/draft ownership before S02b

The full capture registry rewrite is deferred, not silently accepted.

Re-measure after D01, A10, semantic feedback, and wire cleanup. Proceed only if:

- `main.ts` still has multiple independently mutable collections for one capture;
- characterization tests cover concurrent queued captures, live partial/final, timeout, cancel, dismissal races, and shutdown;
- the proposed registry deletes more mutable owners/branches than it adds;
- window geometry remains separate from capture state;
- no framework or generic state layer is introduced.

If those conditions hold, implement one focused capture registry and one transient presentation state. Otherwise close S02b as no longer justified.

## Recommended change-set order

1. Test command integrity.
2. A01a, A03, A07, A09, A11/TurnBuffer, A12, A05 estimator.
3. D01 deletion.
4. D02 capture fixture move.
5. D03 model override deletion.
6. A06 recovery, then A02/S03 config truth.
7. A08 autostart and shortcut analyzer.
8. Native protocol revision: A01b/A13/S06.
9. A05 artifact plans/receipts.
10. A04 runtime callbacks/leases.
11. S04 cleanup contract.
12. A10 audio ownership.
13. D04 retry ownership and S01 polling.
14. S05/S02a view-policy cuts.
15. Release/CI/logging/mechanical cleanup.
16. Re-audit and conditionally schedule S02b.

Each numbered change set should be independently buildable and revertible. Do not combine config, native protocol, renderer IPC, and local-runtime ownership into one mega-change.

## Completion criteria

- Every A finding has a regression test or an explicit manual/E2E validation where deterministic automation would be disproportionate.
- D01 and production portions of D02/D03 are gone.
- Retry remains useful without audio in History snapshots or redundant buffer copies.
- Persisted config is explicitly parsed and internal code no longer treats trusted fields as `unknown`.
- Automatic paste has no magic target and only the manual commit path is targetless.
- Local installation and runtime have one artifact truth and one active-use owner.
- Hidden settings windows do no periodic work; History is lazy.
- Native protocol carries no unused mouse/keyboard/developer payloads.
- Release publishes the exact package output that was smoke-tested.
- `npm run verify`, required scale captures, and applicable smokes/E2Es pass at every phase gate.
