# Cantrip Computer Use

Status: First-tranche observation, logical cursor, managed MCP, shared preview
and protected Trajectory implemented and verified with the release qualifications
recorded in cycle 16. Updater signing, notarization and installed-update permission
verification remain unperformed. Accessibility press and single-left coordinate
clicking are implemented and merged. The user confirmed inspect → click → inspect
in a Codex window on 2026-09-05, satisfying this bounded clicking goal.
The full computer-use roadmap is unfinished. The subsequent custom-cursor and
covered-window goal is active; the earlier global-click test is not its acceptance.

## Custom-cursor and covered-window progress

Goal: act in a covered application window through the custom cursor while
preserving the human pointer, foreground application and window ordering.
Acceptance requires the user's report of that complete outcome. Work is solo,
with sequential worktree PRs and squash auto-merge. The user subsequently
authorized agent-driven interactive testing; implementation does not pause
between useful cycles.

### Sharing a covered window to keep its contents current

- Branch: `codex/cua-covered-window-sharing`; [PR #1791](https://github.com/ArcaneArts/Cantrip/pull/1791)
  squash-merged, Primary synchronized, development helper installed.
- A ScreenCaptureKit display stream filtered to only the selected window now
  keeps covered Chromium rendering. Independent-window screenshots still provide
  full-resolution images and cursor feedback. The macOS sharing badge appeared
  in native fixture captures; it is not evidence that input succeeded.
- One bounded stream is shared by sessions attached to the same window. Last
  detach/close, idle expiry and native interruption release it. Cleanup also
  stops a late startup after cancellation. No target activation, pointer movement
  or new input fallback was added.
- Validation: 57 Rust library tests, build, formatting, Clippy and all four CI
  jobs passed. Integrated covered Chromium fixtures at 600×500 and 1000×700 each
  received one trusted click and visibly captured Count 1, with unchanged sampled
  pointer, foreground app and window order. Native session sharing, last-owner
  cleanup, reattach and startup cancellation passed.
- Optional user check: cover the target app with another window, ask the agent
  to select a different chat and inspect the result, then confirm the actual
  change while your pointer and foreground remain undisturbed. The desktop cursor
  remains behind covering windows; observations show its target-local position.
- Full user acceptance remains pending. Coordinate delivery in Chromium and
  minimized, off-screen or other-Space rendering remain unresolved. See the
  [clicking guide](../COMPUTER_USE_CLICKING.md) for supported methods and limits.

### Enhanced Accessibility activation for application actions

- Branch: `codex/cua-enhanced-accessibility`.
- Window inspection now requests the app-provided `AXEnhancedUserInterface`
  mode when the live attribute explicitly reports false. Already-enabled or
  unsupported attributes are left alone. A rejected opt-in does not block
  ordinary inspection, and there is no fixed readiness delay or input replay.
- This shared process mode is not reset when a CUA session ends, so closing one
  session cannot disable another assistive client. It does not enable system
  VoiceOver, activate a window, or change browser launch flags.
- Validation: 55 Rust library tests, build, formatting and Clippy. A fresh
  normal-mode Chromium fixture received trusted page input and incremented its
  counter using the updated helper without an external accessibility toggle.
  Pointer movement during that run prevents a preservation claim for that run.
- Earlier controlled runs with the same activation established covered Chromium
  AX input with unchanged pointer, foreground and window order. However, covered
  raster capture remained stale, including with a native ScreenCaptureKit stream.
  Disabling occlusion throttling only in a disposable browser made its covered
  capture update. The window-only sharing cycle above subsequently addressed
  covered rendering without adding that browser flag to the product.

### Accessibility windows omitted from the window list

- Branch: `codex/cua-accessibility-window-references`.
- Native evidence showed an empty `AXWindows` list while `AXMainWindow` still
  exposed the exact captured window and its controls. Discovery now also reads
  the application's main/focused window references, deduplicates identical
  references, and applies the existing title/bounds matching and ambiguity
  rejection. It does not activate or raise a window.
- Validation: 55 Rust library tests, build, formatting and Clippy; a native
  fixture reproduced the old `stale-element` result, then resolved the omitted
  window with the updated helper. A different window remained rejected, and
  two distinct matching windows remained ambiguous.
- A disposable Chromium instance with complete Accessibility enabled produced
  a real counter increment through its main-window reference. Concurrent
  desktop changes invalidate any claim of pointer/focus/order preservation in
  that run. The subsequent activation cycle above advances Chromium input;
  full covered-window acceptance remains unresolved.

### Desktop cursor on large windows

- Branch: `codex/cua-large-window-cursor`.
- Replaced the full-window desktop raster with sparse 256×256 logical-pixel
  tiles touched by the shared cursor renderer. Large target windows retain their
  desktop cursor, labels, action feedback and distant trail points without an
  allocation proportional to the window area. Tiles do not overlap or change
  label placement, and remain nonactivating, click-through and behind covers.
- Validation: pixel-for-pixel tiled/full-render equivalence across all four
  styles, translucent colors, Unicode labels, tile boundaries, trails and action
  feedback; bounded large-window and fractional-edge rendering; existing cursor
  tests (13 passed), Rust library tests (55 passed), build and Clippy. Native
  lifecycle checks passed for ordinary and 3000×1800 windows: 487 cursor-colored
  pixels when visible/restored, zero when hidden, covered or detached.
- Input investigation remains separate: AppKit native event logging confirms
  correct recipient/window-local coordinates and counter change beneath another
  process. Chromium native Accessibility tracing reaches selector handling but
  the page receives no button event. No ineffective opt-in, observer, reference-
  retention or event-metadata workaround was added to the product. The goal still
  requires a real covered-window result and user confirmation.

### Experimental background input and desktop cursor

- Branch: `codex/cua-background-pointer`. The user explicitly authorized private
  macOS input APIs and a desktop-visible cursor, then authorized agent-driven
  native and interactive testing for this implementation.
- Added `backgroundClick` through existing managed MCP/permission/worker/Rust
  routing. It prepares window-local SkyLight mouse events and sends one tracking
  event plus one left-button pair, with no activation, global input, duplicate
  posting or automatic fallback. Delivery remains truthfully unverified.
- Added a main-thread, click-through, nonactivating desktop cursor panel using
  the existing renderer. It follows its target and sits behind covering windows;
  detach/close remove it. Own panels are excluded from inventory, CUA monitor
  capture and application-window-order measurements.
- Native investigation: initial helper permission-denied was resolved by the
  user enabling `cantrip-cua`. AppKit counter clicks then succeeded under a
  separate foreground process while sampled pointer, foreground and ordering
  stayed unchanged. Chromium web controls still produced no visible change;
  targeted coordinate and Accessibility routes remain unverified for that case.
  Desktop lifecycle checks passed hide/show, uncover and detach (487 cursor-colored
  pixels when visible, zero while hidden, covered or detached).
- Acceptance remains pending: visible target change under cover while the human
  pointer, foreground app and application-window order remain unchanged.

### Latest cycle — Inspect and identify the AXPress recipient

- Branch: `codex/cua-resolved-controls`.
- User evidence: AXPress reported dispatched at the intended sidebar position,
  but the next saved image still showed CUA selected instead of Jeff. The saved
  image contains the custom cursor and dispatch label over Jeff; no physical
  desktop overlay was implemented. No new capture or native test was run.
- Added read-only `cua.controls({x,y})` to expose the point-specific hierarchy
  to the agent for explicit reference selection, plus selected control metadata
  in Accessibility receipts and protected Trajectory. Existing ownership,
  permissions, reference invalidation and no-global-fallback behavior remain.
- The earlier receipt did not identify the actual AX element. This increment
  makes that distinction observable without inventing a role-based selection
  heuristic. Native dispatch is still not proof of the intended application
  change; the user's covered-window acceptance remains unresolved.
- Validation: eight focused Rust unit tests, 49 worker unit tests (five existing
  skips), 13 app projection tests, Rust Clippy, protocol build and worker/server/app
  typechecks. No native or integration acceptance was run locally.
- User test: ask the agent to inspect controls at the intended item, select the
  matching reference, press once and capture the result. Review the AXPress
  recipient in Trajectory and the cursor in the CUA image/monitoring preview.

### Cycle 1 — Targeted Accessibility cursor actions

- Branch: `codex/cua-cursor-targeted-actions`; [PR #1767](https://github.com/ArcaneArts/Cantrip/pull/1767)
  merged 2026-09-06 UTC as `3e73529b34190fd810b93009b0b322835f9ab506`
  (observed). All four existing CI jobs passed; Primary synchronized and the
  cycle-owned worktree removed.
- `cua.click()` uses the current custom cursor; an explicit point updates it.
  Rust resolves a pressable control from the attached window's hierarchy and
  invokes AXPress without requesting activation, raising or pointer movement.
  Bounded position-specific traversal avoids reliance on desktop z-order hit
  testing or the short general control-discovery list. Incomplete/ambiguous
  selection fails without global fallback, including after an unknown result.
- Global input is separate: `cua.globalClick(point)` / `globalInput: true`.
  Workers always send the selector, so an older helper rejects the new wire
  request rather than silently running its legacy global click implementation.
- Successful input updates the logical cursor action location and adds a visual
  dispatch marker to snapshots/preview, preserving saved cursor appearance.
  Protected activity records distinguish the actual or attempted method.
- Evidence from the previous user test: controls were requested before attaching
  a target in the new turn. After attachment, inspection returned three controls
  and `truncated: true`. Tool instructions now emphasize per-turn attachment;
  targeted search has its own bounded traversal for the action position.
- Validation: Rust compilation; five focused input/dispatch/selection unit tests;
  49 worker unit tests passed and five existing tests skipped; Rust Clippy;
  worker/server/app typechecks; formatting and diff checks. No native/GUI or
  integration acceptance was run by the coding agent.
- User test: cover a harmless application window, ask the agent to attach it,
  capture it, move its custom cursor over a button, call `cua.click()` and capture
  the result. Observe your system pointer and foreground window. No globalClick.
- Remaining: actual focus-effect reporting, targeted coordinate delivery where
  supported, and the user's covered-window/pointer-preservation acceptance.
  AXPress may produce app-defined focus effects; `activation: false` currently
  records that Cantrip did not request activation, not a measured absence of it.

### Cycle 2 — Observed input effects

- Branch: `codex/cua-input-effects`; [PR #1768](https://github.com/ArcaneArts/Cantrip/pull/1768)
  merged 2026-09-06 UTC as `70efe99c0a6df6316319ea5bb1530b0bd3b05c89`
  (observed). All four CI jobs passed; Primary synchronized and cycle worktree removed.
- Native action receipts now carry before/after change summaries for the human
  pointer, foreground application/window and front-to-back on-screen window
  ordering. Missing samples yield unknown and never gate the input attempt.
- Only enums and sample timestamps cross the native boundary; focus handles,
  desktop coordinates and inventory identities used for comparison stay local.
  Existing protected payloads/Trajectory carry the receipt, and the activity UI
  displays the sampled changes. No event tap, continuous monitoring, pointer
  restoration or suppression was added.
- Evidence is immediate and non-atomic. Equal samples do not exclude transient
  or delayed effects, and a changed sample cannot establish causation. Failed
  operations without a receipt do not imply unchanged focus or pointer state.
- Validation: Rust compilation, Clippy and one focused missing/equal/changed-
  sample unit test; worker/server/app typechecks; formatting and diff checks.
  No native/interactive acceptance performed by the coding agent.
- User test: repeat a covered-window custom-cursor action and inspect the
  receipt/Trajectory's sampled changes alongside the visible pointer and focus.
- Remaining: targeted coordinate delivery where supported and actual user
  confirmation of covered-window action with pointer and foreground preserved.

### Cycle 3 — Cursor action outcomes

- Branch: `codex/cua-action-outcomes`; [PR #1769](https://github.com/ArcaneArts/Cantrip/pull/1769)
  merged 2026-09-06 UTC as `cd87732501347034b0b64cf0d0d0c648be1a326f`
  (observed). All four CI jobs passed; Primary synchronized and cycle worktree removed.
- Native cursor-click failures preserve their attempted location and outcome in
  session state for the next observation. Labels distinguish dispatched, failed,
  unsupported, cancelled and unknown; only dispatch gets the center dot. Original
  errors still propagate, and no retry or global fallback was introduced.
- Reference actions clear the preceding marker; only resolved receipt geometry
  receives a new marker. Requests rejected before helper execution or a lost
  helper cannot supply a new native marker. Activity/tool errors remain authoritative.
- Protected input activity distinguishes unsupported from generic failure.
- Validation: Rust compilation/Clippy, two focused routing/selection unit tests,
  nine worker activity unit tests, worker/server/app typechecks, formatting and
  diff checks. No native, interactive or integration testing ran locally.
- User test: after a successful harmless targeted action, attempt a position with
  no pressable control, then request a fresh snapshot. Check that the new marker
  says unsupported rather than retaining the old dispatch marker. Do not retry
  an unknown action automatically.
- Remaining: documented process-targeted coordinate delivery where feasible,
  plus the user's covered-window/pointer-preservation acceptance.

### Cycle 4 — Explicit process-targeted coordinate attempt

- Branch: `codex/cua-process-click`; [PR #1777](https://github.com/ArcaneArts/Cantrip/pull/1777)
  merged as `9a6b74626fe5d5277c3e0168da183486ca2b975d` (observed).
  All four CI jobs passed; Primary synchronized and cycle worktree removed.
- `cua.processClick(point?)` routes one coordinate pair through public
  `CGEventPostToPid`, using the attached window's freshly resolved PID, window ID
  and target-local geometry. It is explicit, authorized as native input, and
  never an automatic fallback from Accessibility or to global input.
- No activation, raise, global post, cursor restoration/hiding or input
  suppression. Existing ownership, ordering, Stop and mouse-up cleanup remain.
- Public window fields carry intended-window identity, not a delivery guarantee.
  The native receipt reports process-coordinate, unknown, windowDelivery unverified
  plus sampled effects. The custom marker and protected Trajectory retain the
  intended location and target; fresh capture must assess the application result.
- Public SDK/header and Apple documentation establish process event-stream
  posting but no promise of covered-window delivery or pointer independence.
  App-defined effects and other-window delivery remain possible. See the user
  guide for sources and limitations. No private fields/APIs were introduced.
- User test: explicitly request processClick once on a harmless control in a
  covered window, then a fresh snapshot. Observe whether the intended window
  changed and whether your pointer, foreground app and window order stayed put.
  Do not automatically repeat an unknown action.
- Validation: Rust compilation/Clippy; eight focused pure Rust tests covering
  routing, identity, Stop cleanup and host arguments; fifteen worker contract/
  activity unit tests; worker/server/app typechecks; formatting and diff checks.
  No native, interactive or integration tests were run locally.
- Implementation handoff: the next required evidence is the user's covered-window
  acceptance. Do not create extra cycles or run native tests in lieu of feedback.
- Covered-window acceptance remains pending. The earlier global foreground click
  and automated checks are not evidence for this required user outcome.

### Cycle 5 — Script rejection and click-method confirmation correction

- Branch: `codex/cua-click-method-guidance`.
- User feedback on 2026-09-06 showed an agent declining to use processClick
  without another confirmation. That restriction came from the MCP instructions;
  a user-authorized click now permits method selection under existing native-input
  authorization. Global input remains separately explicit. Denial, Stop, revocation
  and unknown dispatch never justify retry or method switching.
- The corresponding rollout shows `let shot` in the capture call and another
  top-level `let shot` in the later click script. A pure QuickJS unit reproduced
  the rejection before any host dispatch. The reported failure is therefore not
  evidence of an Accessibility click failure. Control inspection did return three
  controls and a truncated list, but the attempted click never reached native input.
- A new sanitized script-evaluation error distinguishes evaluation failures before
  any host call. Guidance explains persistent bindings and block-scoped temporary
  variables. Post-host failures cannot claim no dispatch; no scripts are retried
  automatically and private exception text is not exposed.
- Validation: nine focused Rust JavaScript unit tests, Rust compilation/Clippy,
  worker typecheck, formatting and diff checks. No native/interactive or
  integration tests were run locally.
- User test: repeat the original click request in an updated dev worker. The agent
  should use valid persistent-session scripts and select an authorized targeted
  method without asking you to name processClick. Covered-window pointer/focus
  preservation remains pending your observation.

### Cycle 6 — Click receipt validation and host failure recovery

- Branch: `codex/cua-receipt-validation`.
- The latest user test reached click and then failed its follow-up snapshot. Its
  rollout contains only generic rejection text, so the exact original native
  failure cannot be recovered from that evidence.
- Inspection found worker validation still required global-coordinate receipts
  for every click. It now accepts the requested AX, process or global method,
  including clicks at the current logical cursor; mismatched receipts still fail.
- QuickJS now preserves an uncaught host rejection's original code by object
  identity. Script-controlled error fields cannot forge that classification;
  handled errors and unrelated script exceptions retain their own behavior.
- MCP guidance explains that a failed script releases its attachment. Observation
  recovery requires fresh target discovery/attachment, without replaying input.
- Validation: 11 focused Rust JavaScript unit tests, three pure worker receipt
  tests, worker typecheck, Clippy, formatting and diff checks. No local native,
  GUI or integration testing. Covered-window acceptance remains with the user.

### Cycle 7 — Actionable window-control rejection

- Branch: `codex/cua-targeted-click-recovery`.
- User evidence now confirms `unsupported` from window `click`, followed by an
  ineffective monitor-target retry. No processClick was attempted. The generic
  code did not establish whether control inspection was incomplete, ambiguous,
  or found no matching control; it cannot prove the app exposes no usable AX row.
- Native control selection now reports those three cases separately. Safe error
  text and MCP instructions direct the model to reacquire the same application
  window and select the separate process-targeted attempt for an authorized click
  after confirmed no dispatch. Monitor substitution is explicitly ruled out.
- Specific rejection codes survive JavaScript and protected Trajectory while the
  cursor/action outcome remains unsupported. No native automatic fallback,
  permission change, input replay or claimed process-delivery guarantee is added.
- User test: repeat the original harmless click request in the updated worker.
  If AX selection rejects it, expect an explicit processClick against the same
  window and a fresh snapshot, without another method-name confirmation. Report
  the actual window change and whether pointer/focus/window ordering stayed put.
- Validation: 13 focused Rust unit tests, 21 worker contract/activity tests,
  worker typecheck, Rust Clippy, formatting and diff checks. No local native,
  interactive or integration testing.
- Covered-window acceptance remains unresolved and belongs to the user.

### Cycle 8 — Use the bounded window search budget

- Branch: `codex/cua-window-traversal`.
- User evidence and rollout confirm AX control-inspection-incomplete in about
  160 ms, followed by processClick on the same window. The user-provided result
  still showed CUA rather than Jeff. Process delivery did not establish the
  intended change; no additional input was issued during this investigation.
- Targeted AX traversal now uses the existing 512-node total budget without the
  smaller 24-level/128-child cuts. General discovery retains its smaller limits.
  Repeated native element identities are visited once. Boundary leaves are
  checked for actual children rather than automatically labelled incomplete.
- The queue and retained identities remain bounded, the existing deadline and
  Stop checks remain, and missing/ambiguous/incomplete selection still fails.
  Window ownership, geometry revalidation, secure-input omission and no global
  fallback remain in the native action path.
- Validation: four pure traversal unit tests, Rust compilation/Clippy, formatting
  and diff checks. No native, interactive or integration tests ran locally.
- Next user test: a newly authorized click on the intended covered window with
  the updated worker. This is not an automatic replay of the prior unknown input.
  Actual AX success and pointer/focus preservation remain unverified.

## Clicking-tranche progress

Implementation proceeds solo through isolated worktrees and squash auto-merge.
The user's later instruction removes the original pause between cycles. Native,
GUI and integration acceptance is reserved for the user; silence is not a pass.

### User acceptance — Inspect, click and inspect

- On 2026-09-05 the user reported that the Cantrip agent could see a Codex
  application window, click a different chat and find its information. The
  supplied conversation screenshots show target attachment and snapshots, and
  the agent reports a fresh post-click image with the requested chat selected.
- The user observed their system pointer move and click, without a separate
  agent mouse. This matches coordinate input: the logical teal cursor is drawn
  into CUA snapshots/preview; native coordinate clicks use the shared macOS
  pointer. An independent input pointer was not part of this tranche.
- This is user acceptance of the bounded inspect → click → inspect outcome,
  not a claim that every native branch was exercised. Accessibility inspection
  initially failed in the supplied sequence; successful Accessibility press,
  all policy combinations and Stop timing were not independently user-verified.
  The implementation and focused-check evidence for those paths remain recorded
  below. No native or interactive acceptance was run by the coding agent.
- Delivered implementation: [PR #1761](https://github.com/ArcaneArts/Cantrip/pull/1761),
  [PR #1762](https://github.com/ArcaneArts/Cantrip/pull/1762), and recovery correction
  [PR #1764](https://github.com/ArcaneArts/Cantrip/pull/1764), all observed merged.
  The full observation/deferred roadmap and unsupported capabilities remain as
  documented. No further implementation cycle is required for this bounded goal.

### User feedback — Script syntax and revoked turn authority

- Branch: `codex/cua-script-recovery`; [PR #1764](https://github.com/ArcaneArts/Cantrip/pull/1764)
  merged 2026-09-06 UTC as `19b2a697b64defaf309bbcb6d4343e41abf1bd93`
  (observed). Primary was synchronized and the cycle worktree removed.
- The agent discovered the managed tools but sent `return await cua.targets();`.
  QuickJS rejected the top-level return before dispatch. A subsequent permission
  profile change revoked this turn's authority before the agent tried reset.
- The `codex/cua-script-recovery` change documents top-level await and final
  expression results in tool instructions, adds a sanitized `script-syntax`
  native error, and explains that reset cannot restore revoked turn authority.
- Validation: seven Rust JavaScript unit tests, twelve worker authority unit
  tests, worker typecheck, formatting and diff checks. All four existing CI jobs
  passed: macOS, Windows, Linux and PostgreSQL authority. Native and integration
  acceptance was subsequently reported above. Send a new agent message after
  changing a permission profile and use `{"script":"await cua.targets()"}` for discovery.
- Subsequent result: the user confirmed window inspection, clicking and reading
  the changed state, as recorded above.

### Clicking cycle 1 — Accessibility inspection and press

- Branch: `codex/cua-clicking-accessibility`; [PR #1761](https://github.com/ArcaneArts/Cantrip/pull/1761)
  merged 2026-09-05 as `7bb8d943e28e888178e869b6ec713f62ed29a3a8` (observed).
- Implemented: managed `cua.controls()` and `cua.press(reference)`, bounded
  Rust-owned references, current application/window matching, separate `controls`
  observation and `native-input` mutation approval classes, protected Trajectory
  receipts. Selected YOLO adds no app-level confirmation; macOS permission errors
  come from the actual AX operation. Logical cursor behavior remains unchanged.
- Bounds: 128 visited elements, depth 12, 32 pressable controls per inspection,
  bounded labels and three-second traversal budget with 200 ms AX message limits.
  No AX values or secure-field descendants are read. Inspection replaces old
  references; press consumes them, including when the outcome is unknown.
- Validation: Rust compile/Clippy, protocol build, worker/server/app typechecks,
  31 focused worker permission/contract unit tests and one Rust wire unit test.
  CI subsequently caught the three new public schemas missing from the explicit
  export baseline; cycle 2 corrects that baseline. Native and integration tests
  were not run by the coding agent. Accessibility-press-specific user testing
  remains unreported; the user accepted the overall clicking outcome above.
- Limitations: macOS application windows only. Requires a unique AX window with
  matching current PID, geometry and available title; ambiguous matches fail.
  Incomplete/virtualized AX trees may omit controls. Action dispatch does not
  establish the intended visible result. Unknown actions must never be retried
  or automatically replaced by coordinate clicks.
- User test: in a development build containing this change, ask an agent to
  attach a harmless application window, inspect controls, press a named button
  and take a fresh snapshot. Expect a separate input approval outside YOLO and
  a protected Press control event. Use Stop while approval is pending to cancel.
- Next: coordinate single-left click and necessary activation/focus handling.

### Clicking cycle 2 — Coordinate single-left click

- Branch: `codex/cua-clicking-coordinate`; [PR #1762](https://github.com/ArcaneArts/Cantrip/pull/1762)
  merged 2026-09-05 as `d1a323cff01b4e8bba705678c5648be859fb4ae3` (observed).
- Implemented: `cua.click({x,y})` through the same managed tool, mutation approval,
  session queue and protected Trajectory path. Window clicks request AX activation
  and raise, resolve the resulting geometry and verify the live hit target.
  Monitor clicks use their current global origin. Receipts report actual method,
  activation, logical/global positions and dispatch; no application result is
  inferred. The single-button pair always releases after down, even during Stop.
- Corrected the cycle-1 public export baseline to include exactly its three new
  schemas; unrelated baseline names and fingerprints remain checked.
- Lightweight validation: Rust Clippy; three Rust input/dispatch unit tests;
  three protocol export unit tests; 32 worker permission/contract unit tests;
  protocol build and worker/server/app typechecks. No native, GUI, integration,
  packaged-app or release tests were run locally. Existing CI passed on macOS,
  Windows and Linux, plus PostgreSQL authority checks, before the squash merge.
  The cycle-1 export-baseline failure is resolved. User acceptance is recorded
  above.
- User steps and limitations: [clicking guide](../COMPUTER_USE_CLICKING.md).
  Coordinate input can affect focus and the human system pointer; dispatch is
  not proof of an application action. macOS only, with explicit unsupported
  errors for unsuitable AX windows. No double/right clicks, keyboard or drag.
- Result: the user confirmed that an agent can inspect, click and inspect the
  result. Shared system-pointer movement was observed and is an explicit
  coordinate-click limitation, not an independent agent pointer.

The installed Cantrip 1.1.1781 worker inspected during this task lacked the CUA
MCP module. The current source registers managed `cantrip_cua`; testing requires a
build containing it. This tranche does not modify the installed app or releases.

## First-tranche implementation progress

The completed first tranche covered observation and a customizable logical cursor:
Rust process, worker service, encrypted server routing, client preview,
macOS snapshots, managed MCP, permissions, and Trajectory. Native input and
Accessibility actions were deferred at that boundary; the clicking tranche above
now implements bounded press and single-left click. Clipboard/file mutations,
human event taps, Windows, Linux, and cross-worker control remain deferred. The full plan below
describes the larger architecture; its operation list is not a requirement to
implement later-tranche operations now.

### Tranche cycle 1 — Contracts and feasibility

- Branch: `codex/cua-01-feasibility`, based on `6b7df74b1`.
- PR: [#1733](https://github.com/ArcaneArts/Cantrip/pull/1733).
  Initial implementation commit: `3d1842785`; merged 2026-09-04 as
  `1e2da3de9f4ee08afb7b56b5e84b937606e4bf2b` (observed via GitHub).
- Implemented behavior: progress ledger and opt-in native/JavaScript
  [feasibility probes](../../scripts/cantrip-cua/feasibility/README.md).
  Product behavior remains unavailable; no startup or packaging changes.
- Validation: repository build, managed MCP, permission, encryption, and
  Trajectory seams inspected. Native fixture captured an occluded red window
  (256 × 192) in 122–137 ms. Distinct signed debug/optimized builds both captured
  successfully with equal designated requirements. A separate timestamped,
  hardened-runtime Developer ID fixture passed strict signature verification.
  JavaScript: five tests, release probe, formatting, and Clippy passed; persistent
  globals, absent ambient I/O, deadline, heap bound, and reset exercised.
- Platform: macOS only for native investigation; portable JavaScript probe.
- Manual verification: fixture native pixels verified on macOS 27 arm64.
  Parent-app TCC attribution, installed helper permission reuse across
  worktrees, and packaged update capture remain unverified.
- Risks: stable signing requirement alone does not prove TCC permission
  continuity; this must be exercised with the installed helper. JS engine
  limits do not bound native host calls or image memory.
- Decisions: focused objc2 ScreenCaptureKit bindings; macOS 14+ CUA snapshot
  capability (no app-wide minimum change); rquickjs 0.12.2 evaluator without
  host I/O/module loader. Production implementation remains subsequent work.
- Remaining tranche work: all production Rust, build, worker, server, client,
  native capture, MCP, permission, Trajectory, and end-to-end cycles.
- Deferred: all native input and mutations, other operating systems, and
  remote-worker desktop control.

Subsequent cycles record the preceding PR's observed merge commit. A cycle's
own final merge cannot be truthfully written before GitHub merges it; its PR
is the authoritative merge record until the next ledger update.

### Tranche cycle 2 — Rust process, sessions, fake capture, and cursor

- Branch: `codex/cua-02-rust-foundation`, based on merged cycle 1 (`1e2da3de9`).
- PR: [#1734](https://github.com/ArcaneArts/Cantrip/pull/1734).
  Initial implementation commit: `67019f00a`; merged 2026-09-04 as
  `c6982b46d2d7170d363ceb58cc9fbcdbeb4577ee` (observed via GitHub).
- Implemented: standalone `cantrip_cua` library/executable and lockfile; bounded
  raw-binary protocol; independent cancellation reader; serialized session
  ownership; explicit fake monitor/window backend; PNG observations with digest;
  versioned configurable logical cursor and deterministic raster renderer.
  Default native capability remains unavailable; no startup/build-chain changes.
- Validation: all 47 protocol, cursor, service, runtime concurrency, and
  actual-executable tests pass in debug and release; release build, focused
  Clippy, formatting, and Windows GNU target cross-check pass. Executable test
  completes handshake, target attach, configuration/movement, decoded PNG
  hotspot verification, close, and shutdown. Runtime tests prove in-flight and
  queued cancellation, EOF, saturation, and lost-output handling with real
  reader/executor/writer threads and no scheduling sleeps.
- Review fixes: unknown fields rejected for all operations; target-bound
  requests carry ID **and** generation to prevent wrong-target commands after a
  switch; lost stdout cancels native work; shared-target attachment preserves
  observer cursor state; resized targets discard invalid trail points.
- Platform: tests executed on macOS arm64 with deterministic fake pixels.
  Windows cross-compilation is compile evidence only, not Windows runtime QA.
- Manual verification: native pixels remain cycle-1 prototype evidence, not
  production Rust capture. Installed helper/Tauri permission reuse unverified.
- Known limitations: embedded bitmap cursor labels do not implement full text
  shaping; native adapters must cooperatively honor cancellation/deadlines.
- Remaining: build/package/smoke integration, worker service, protected server
  routing, client preview, native Rust capture, managed JS/MCP, approval and
  Trajectory wiring, full end-to-end verification.
- Deferred: native input/mutations, human event taps, Windows/Linux native
  backends, remote-worker control, continuous video, and arbitrary cursor assets.

### Tranche cycle 3 — Build chain, stable helper installation, and packaged smoke

- Branch: `codex/cua-03-build-chain`, based on merged cycle 2 (`c6982b46d`).
- PR: [#1735](https://github.com/ArcaneArts/Cantrip/pull/1735).
  Initial implementation commit: `e3f320d2`; merged 2026-09-04 as
  `9e8ded7d6ab403be29208a3124391752d4467098` (observed via GitHub).
- Implemented: root CUA build/check/test/smoke commands; Cargo-reported executable
  selection; worker and inherited desktop bundling; final-layout protocol smoke;
  explicit macOS signing identifiers; named user-data development installation
  independent from build/worktree paths. Signing configuration is retained across
  rebuilds, installation is OS-lock serialized, and failed signing/smoke preserves
  the prior executable. No worker runtime activation or native capture yet.
- Validation: 50 Rust tests and 24 CUA script tests pass; focused Clippy/format,
  release build, Windows GNU cross-check, and diff/large-file checks pass.
  Actual copied worker/desktop-layout smoke covers both fake targets, four cursor
  styles, binary PNG metadata/digest, deterministic repeat captures, and shutdown.
  The actual development CLI is exercised (including a fixed circular-import
  startup deadlock). Broad script run: 142/144 pass; the App Platform build-command
  assertion and network Tranche Two missing-test-name assertion also fail on
  unchanged Primary `c6982b46d`. They remain recorded baseline regression work,
  not claimed passing or silently bypassed.
- Platform: local macOS arm64 fake execution; added macOS/Windows/Linux CI matrix,
  macOS and Linux jobs passed in run `33927526148`; Windows Rust tests passed,
  but one script test incorrectly asserted POSIX execute bits on Windows.
  Follow-up cycle 3b corrects that host-specific assertion. Native capture
  remains only cycle-1 prototype evidence.
- Manual verification: named `cua-cycle-three-qa` development helper installed
  in native user data with Apple Development signing; debug and release builds
  both passed actual smoke with equal designated requirements. Developer ID
  final-layout helper passed strict signature verification and fake smoke
  (60 ms release sample, not a native capture benchmark). The named QA helper
  remains installed for subsequent native validation. Actual TCC reuse across
  worktrees and capture permission behavior remain cycle-7/end-to-end work;
  neither is implied by signing or fake smoke. A full app/DMG build was not run
  in this cycle; final-layout helper verification is not outer-app notarization.
- Risks: standalone worker release artifacts are not yet certificate-signed by
  their release job; desktop nested signing does not prove that separate path.
  Moving/translocating the installed outer app can change its absolute path.
- Remaining first tranche: lazy worker service and binary resolution; protected
  shared protocol/server routing; preview/customization UI; native Rust capture;
  persistent JS/managed MCP; durable approvals, Trajectory, and end-to-end audit.
- Deferred: native input and mutations, human event taps, Windows/Linux native
  capture, arbitrary cursor assets, continuous video, and cross-worker control.
- Developer/build/inspection/reset instructions:
  [CUA runtime README](../../cantrip_cua/README.md#stable-development-helper).

### Tranche cycle 3b — Installer lifetime and Windows test follow-up

- Branch: `codex/cua-03b-install-lifecycle`, based on merged cycle 3 (`9e8ded7d6`).
- PR: [#1736](https://github.com/ArcaneArts/Cantrip/pull/1736).
  Initial implementation commit: `49e4a4b7`; merged 2026-09-04 as
  `cbfa5df6d4f9308947bd485dc8d980caed323829` (observed via GitHub).
- Implemented: preserve lock-holder lifecycle observation after acquisition;
  cancel smoke and refuse subsequent commit steps after actual lock loss.
  Correct POSIX-mode test assertions to use the actual host platform while
  retaining cross-platform executable-name and copied-byte checks.
- Validation: 50 Rust tests, 26 CUA script tests, actual-binary smoke, focused
  Clippy/formatting, and diff checks pass locally. Actual-child lock-loss
  regression preserves prior binary/configuration; cancellation disposes active
  smoke processes. Independent focused review found no additional defects.
  CI run `33927937100` passed all macOS, Windows, and Linux CUA jobs.
- Platforms/manual status: macOS fake runtime locally and actual fake runtime
  execution in macOS/Windows/Linux CI. No new native capture or TCC claims.
- Risks/remaining: cycle-3 standalone-worker signing, baseline script failures,
  and first-tranche worker/server/client/native/MCP/policy/Trajectory integration
  remain unchanged. Deferred later-tranche work remains unchanged.

### Tranche cycle 4 — Lazy worker service and private process transport

- Branch: `codex/cua-04-worker-service`, based on merged cycle 3b (`cbfa5df6d`).
- PR: [#1738](https://github.com/ArcaneArts/Cantrip/pull/1738).
  Initial implementation commit: `b972ff20`; merged 2026-09-04 as
  `16218ed0d94d7bab4f2e8b5a69556392460f8223` (observed via GitHub).
- Implemented: inert worker service construction; actual framed handshake on
  first authorized use; immutable execution/account ownership; per-session
  serialized operations; raw PNG validation; immediate local scope revocation;
  cancellation with explicit unknown-outcome reporting; exactly one explicit
  crash restart without mutation replay or old-session revival. Worker interrupt,
  relocation, terminal disconnect/reconnect, and shutdown own lifecycle cleanup.
  No public routing, MCP access, native permission request, or Remote Desktop
  change is introduced.
- Build/development: module-relative packaged helper selection; explicit binary
  override; stable named-profile projection for browser/direct worker and desktop
  development; preserved tsx watch and exact orphan-process cleanup behavior.
  `pnpm cua:test:worker` and portable CI execute the actual worker/Rust boundary.
- Validation: 122 focused worker tests pass, including 11 real-Rust integration
  tests; 50 Rust and 30 CUA script tests pass; 13 existing development/profile
  tests pass; worker typecheck/build and CUA Clippy/format pass. Full worker suite
  initially reported 1,136 passes, 13 skips, and one goal-streaming timing failure
  (empty final text); that unchanged test passes in isolation on Primary. The
  complete rerun passed 1,137 tests with 13 expected skips (including the 11
  separately executed Rust-artifact tests). Final-head portable CI run
  `33929428361` passed all three platforms before auto-merge.
- Review fixes verified: synchronous launch failure is terminal; cancellation
  while awaiting a shared handshake/queued operation settles promptly without
  cancelling other callers; disconnect cannot publish a just-completed protected
  target inventory; completed-but-cancelled mutations cannot revive a session.
  Transport admission counts pending cancellation correlations and reserves
  16 additional slots for lifecycle cleanup, so cancellation saturation cannot
  crowd out Stop/session-close requests.
- Platform/manual: actual fake helper/service on local macOS arm64; macOS,
  Windows, and Linux worker integration CI passed. No product/native/TCC verification
  claimed; helper still defaults to unavailable native capture.
- Risks/remaining: encrypted shared routing, worker capability publication,
  client preview, native capture, persistent JS/MCP, durable approvals, protected
  Trajectory, and full end-to-end/packaged verification remain required.
  Turn-specific JS teardown awaits real runtime-turn ownership in the MCP cycle.
  Prior standalone-worker signing and baseline script failures remain open.
- Deferred: native input/mutations, human event taps, other native operating
  systems, arbitrary cursor assets, continuous video, and cross-worker control.

### Tranche cycle 5 — Shared encrypted contract and isolated routing

- Branch: `codex/cua-05-protected-routing`, based on merged cycle 4 (`16218ed0d`).
- PR: [#1739](https://github.com/ArcaneArts/Cantrip/pull/1739).
  Initial implementation commit: `9c8b442fe`; merged at
  `2026-09-05T00:02:16Z` as `0d23ecbae`. Primary fast-forwarded; only the
  cycle-owned worktree and branch were removed.
- Implemented: one browser-safe shared CUA schema; strict worker command/event
  contracts; endpoint-only control/result encryption and sequential 256 KiB
  screenshot chunks (16 MiB total); raw-byte adapters using existing component
  grants; server relay factory and worker handler with mandatory authorization
  and trusted execution ownership. No native-session tables or new key custody.
- Activation status: factory and handler are deliberately not installed in the
  production request dispatcher yet. Worker capability publication remains
  required with activation, not inferred from an OS name or helper path.
- Verified behavior: test client codec -> Fastify route -> worker handler ->
  lazy service -> actual Rust fake helper opens a session, configures all four
  cursor styles, moves, captures/decrypts/verifies PNG bytes, and closes. The
  server sees neither target titles/IDs, cursor labels nor pixels; it only
  accumulates bounded ciphertext for one response and discards its collector.
- Lifecycle: execution lifetime is supplied by the trusted runtime owner and
  spans pending authorization as well as native work. Revocation cannot let a
  delayed approval start a new helper/session. Scoped Stop skips operation
  approval, but still authenticates the sealed action and session ownership.
- Validation: 238 focused CUA/adapter tests pass across protocol (47), crypto
  (20), worker (127), server (39, including 12 real-Rust routing tests), and
  client (5). Full protocol (500) and crypto (60) suites pass; 16 focused
  client encryption tests pass; Rust (50), CUA scripts (30), Clippy, formatting,
  worker/server/app typechecks, server-boundary audit and large-file/diff checks
  pass. Full worker rerun passes 1,143 tests with 13 expected skips. Its first
  loaded run hit unchanged CodeGraph output and Codex stdin EPIPE races; both
  files pass on Primary and branch in isolation, and the EPIPE also reproduces
  synthetically on Primary. These remain final-hardening follow-ups, not CUA
  regressions hidden by skipped tests. Full server reported 794 passes and
  20 failing assertions/8 failed suites. Clean Primary reproduces all 26 common
  failure headings with the same leading cause (mostly existing database
  fixtures, catalog/label expectations and finite-timeout count drift). Two
  branch-only full-run timeouts (project placement and task dispatch) do not
  recur in rebuilt-dependency focused runs: both Primary and branch produce
  identical 34 passes/2 existing failures. The full server suite is therefore
  not claimed green; these baseline gaps remain final regression work.
  First portable CI run `33931195514` passed the Rust round-trip tests on all
  three platforms but exposed a missing logging-package build prerequisite in
  the new server test command; the command now builds its workspace dependencies
  explicitly. Final portable CI `33931458355` passed on macOS, Windows and Linux
  before auto-merge was enabled. Native capture, live app entry
  points, real policy prompts and MCP are not claimed by this factory integration.
- Sequencing decision: existing durable interactions are Codex RPC-owned and
  currently require a real native thread; they are not a generic CUA approval
  owner. Enabling a route using authentication or YOLO alone would omit the
  requested effective-policy behavior. Cycle 5b will therefore implement the
  permission/trusted execution prerequisite from original tranche cycle 9
  **before** exposing the client preview. It must preserve genuine nullable
  idle thread/turn identity, avoid fabricated IDs, preserve ordinary chat
  approval/status behavior, and wire cancellation leases to real lifecycle
  events. This is a scoped sequencing change, not a second approval system.
- Transport limitation: current worker event delivery is best effort across
  disconnects. The authenticated final manifest rejects missing, duplicate,
  reordered, substituted or wrong-revision chunks; it does not replay failed
  mutations or claim resumable image delivery. No WorkerLink/Remote Desktop
  changes or global WebSocket limit increases are introduced. The HTTP request
  has a bounded deadline; HTTP disconnect does not yet cancel worker requests.
- Remaining first tranche: production policy/ownership activation and capability
  publication; client preview; native inventory/capture; persistent JS/MCP;
  protected Trajectory; real macOS/packaged end-to-end verification. Native
  inventory must respect the existing 64 KiB response-header budget. Previously
  noted standalone-worker signing and unrelated baseline script failures remain.
- Platform/manual: local macOS fake process and three-platform fake CI passed. No OS privacy
  prompt, screen access, profile or native key access occurs in this test suite.
- Deferred: native input/mutations, human event taps, other native operating
  systems, arbitrary cursor assets, continuous video and cross-worker control.

### Tranche cycle 5b — Durable computer-use permission owner

- Branch: `codex/cua-05b-durable-approvals`, based on merged cycle 5 (`0d23ecbae`).
- PR: [#1740](https://github.com/ArcaneArts/Cantrip/pull/1740).
  Initial implementation commit: `e9589426b`; merged 2026-09-05 as
  `5e18d1c104fe919927d3c743451af131bdaf590c` (observed via GitHub).
- Implemented: an explicit `computer-use` owner in existing durable agent
  interactions; a versioned migration adds owner metadata and allows genuine
  null native thread/turn identity for CUA permissions. No new session tables,
  encryption profiles, grant formats or key custody. Historical absent-owner
  Codex JSON and ciphertext remain unchanged; its real thread requirement and
  waiting/running restoration remain in force. CUA create, resolve, expiry and
  interruption never rewrite the chat's runtime status.
- Worker policy maps inventory, capture and logical cursor operations onto the
  existing selected/effective profile. Exact selected YOLO requires no extra
  approval, including Primary's effective read-only override for this
  non-filesystem/non-native-input tranche. Other selections use the existing
  protected permission interaction; capability discovery and scoped Stop do not
  prompt. There is no application blocklist or connectivity preflight.
- The inert approval manager seals requests and opens replies using existing
  `interaction-content` grants. It coalesces exact requests, binds grants to
  account/server/worker/chat/lane/profile/target-generation/execution lease,
  expires pending requests after five minutes, and bounds pending requests (32),
  grants (64) and exact-response receipts (128). Denial grants nothing; retries
  never replay native operations or replenish consumed one-use grants. Idle
  preview requests show **Grant once**, not a fabricated turn. Active native
  turns retain their actual identity and the existing turn button.
- Server response routing validates current account/chat/worker/lane and routes
  the encrypted reply to the originating worker without selecting a model or
  Codex RPC. Durable resolution follows worker acknowledgment. A bounded worker
  receipt handles an exact retry after a database-write failure; it never treats
  arbitrary modified response bytes as the same approval. Interrupted/stale
  approvals report bounded errors. Existing Codex response paths are preserved.
- Lifecycle verified in isolation: cancellation during seal/open, direct expiry
  checks after asynchronous work, chat/thread revocation, terminal disconnect,
  shutdown, stale target/profile/lease rejection, and Stop after revocation.
  Production construction and response dispatch are installed and inert; native
  operation routing is still deliberately unregistered. The next activation
  pass must own trusted leases, publish/terminalize durable requests, and abort
  them on actual turn completion, policy/lane change and preview Stop. This
  prerequisite does not claim that a live preview or MCP is already available.
- Validation: 346 focused tests pass (protocol 58, crypto 20, worker 186,
  server 68, client 14), including actual Rust fake routing, 9 real PGlite
  migration/lifecycle tests and historical Codex response/JSON compatibility.
  Migration rollback is exercised after each of its three statements; all 89
  existing tables remain. Full protocol: 516 passes; full worker: 1,202 passes,
  13 expected skips (the artifact-dependent CUA cases run in the focused suite).
  Rust: 50 passes; CUA build/smoke scripts: 30 passes. Worker/server/app
  typechecks, worker build, Clippy, Rust and
  touched-file formatting, large-file check and server-boundary audit pass.
  Portable CI run `33932973259` passed on macOS, Windows and Linux before
  squash auto-merge. The existing server
  local-foundation provider-fixture failure was reproduced unchanged on Primary
  before interaction assertions; full-suite baseline gaps recorded above remain
  final-hardening work, not a claim of a green whole-repository suite.
- Platform/manual: synthetic encrypted permissions and macOS fake-process tests
  only. No native capture, Screen Recording prompt, real profile/key access or
  live UI approval was performed. Portable fake CI exercised these same
  boundary tests on macOS, Windows and Linux; it is not native capture evidence.
- Remaining first tranche: trusted production activation/capability, preview,
  native inventory/capture, persistent JS/MCP, protected Trajectory, signing and
  end-to-end/manual performance verification. Earlier signing and baseline-test
  risks remain. Later native input, other native platforms, arbitrary cursor
  assets, continuous video and cross-worker control remain deferred.

### Tranche cycle 5c — Trusted preview lifetime and production routing

- Branch: `codex/cua-05c-preview-authority`, based on merged cycle 5b
  (`5e18d1c10`). PR: [#1741](https://github.com/ArcaneArts/Cantrip/pull/1741).
  Initial implementation commit: `81f2b8a42`; merged at
  `2026-09-05T01:11:07Z` as `3a5628d234933b1d10278b4ee7a044f45a93323e`.
  Primary fast-forwarded; only the cycle worktree/branch were removed.
- Implemented: production preview/open/Stop routes and encrypted operation
  dispatch through the same agent worker, one inert worker-owned preview lease
  per chat, and actual selected/effective permission policy. Native helper
  construction and preview opening do not launch a process or prompt. Existing
  durable protected interactions carry requests and replies; an approval never
  automatically replays an action. Selected YOLO adds no CUA confirmation.
- A preview is a real client actor with null task/thread/turn/lane fields, not
  an invented native execution. Its lifetime follows worker, chat, account,
  placement and permission authority. Ordinary agent turns, status, messages
  and reused execution-lane IDs do not restart it. Multiple observers receive
  the same active lease. Stop, chat interruption, terminal disconnect, shutdown
  and authority changes invalidate the lease, operations and approvals. Stop
  remains routable after chat archival or placement changes.
- Requests, result manifests and individual image chunks are authenticated to
  the random preview lease as well as the existing endpoint context. Reopening
  cannot reuse an old encrypted action or grant. Strict shared control schemas
  contain no public target titles, cursor labels or pixels. Existing historical
  protocol export/discriminator baselines remain unchanged outside explicit CUA
  additions.
- Migration 0199 adds only a chat authority generation, not a native-session
  table. Narrow transactional triggers advance it for permission, inherited
  default, placement and archive changes, including A-to-B-to-A transitions;
  no-op writes and ordinary turn activity leave it alone. Post-commit database
  notifications deliver best-effort scoped interruption across server instances.
  The generation remains the next-request fence if notification delivery fails;
  there is no claim of instantaneous cancellation across a network failure.
- Review fixes: real PostgreSQL reproduced a project-policy/turn-start lock
  inversion (`40P01`). The production lock now uses a materialized project-lock
  dependency before locking its chat, in one statement; the same harness runs
  the old failure and verifies the actual replacement SQL. Post-commit
  notification delivery/rollback/deduplication/unsubscribe are also tested on
  PostgreSQL and PGlite. Notifications carry only owner/scope IDs, use bounded
  coalesced delivery, and never hold an ordinary committed mutation open for
  an offline worker.
- A real two-instance coordinated-relay test reproduces Stop notification
  delivery before its approval event and during the approval insert. The
  request-origin server now subscribes before dispatch and orders standalone
  terminal notifications behind already-active scoped commands and inserts.
  The bounded completion registries hold no protected payloads, add no RPC or
  polling, and do not evict an insert merely because HTTP timed out. Ordered
  same-command terminal events do not wait on their own completion. Live
  updates retain the captured account owner.
- Integration tests exercise the actual preview and operation route factories,
  worker coordinator, permission manager, Rust fake subprocess and client AEAD:
  target inventory, window attachment, cursor configuration/movement, PNG
  digest/pixels, generation invalidation, ordinary-turn stability and Stop.
  The client UI, production macOS backend and MCP are not implemented by this
  pass. The default Rust backend still reports unavailable truthfully.
- Validation: 472 focused tests pass (protocol 68, crypto 24, worker 219,
  server 147, client 14), plus 2 real PostgreSQL tests run independently on an
  isolated local cluster. The ordinary runner skips those two without an
  explicit dedicated database URL; a dedicated PostgreSQL CI job runs them.
  Full protocol 536 passes, crypto 64 passes, full worker
  1,234 passes / 14 expected skips; the artifact-dependent preview test passes
  against the actual Rust binary separately. Rust 50 and script 30 tests pass;
  Clippy/format, worker/server builds, worker/crypto/app/server typechecks,
  server-boundary audit and repository decomposition check pass. Final-head CI
  run `33935269532` passed all three portable jobs and PostgreSQL 16 authority
  verification before squash auto-merge. Prior whole-server baseline gaps remain tracked
  final-hardening work, not a claim that all repository tests are green.
- Platform/manual: synthetic keys, encrypted fixtures and the fake backend
  only; no user key access, native Screen Recording prompt, live preview UI or
  real screenshot was exercised. Portable fake CI passed on all three platforms.
- Remaining first tranche: client preview/capability presentation, native
  inventory/capture, managed bounded JS/MCP using actual runtime identity,
  protected Trajectory, standalone release signing, full regression and native
  end-to-end/performance/manual verification. The later native-input/platform,
  custom-asset, continuous-video and cross-worker scope remains deferred.

### Tranche cycle 6 — Encrypted client preview and shared cursor

- Branch: `codex/cua-06-client-preview`, based on merged cycle 5c
  (`3a5628d23`). PR [#1742](https://github.com/ArcaneArts/Cantrip/pull/1742),
  implementation commit `c6824fec969d8a1c6c6edab3ec7da95bb2e8e0a7`.
  Squash auto-merged 2026-09-05 as
  `86322d280bf5a2d1f8f40c2e5ebfad4813ef77b0` (observed via GitHub).
  Final-head CI run `33937234829` passed all four macOS/Windows/Linux fake
  capture and PostgreSQL authority jobs before auto-merge. Primary was
  fast-forwarded; only this cycle's clean worktree/branch were removed.
- Implemented: reachable experimental preview above both project and standalone
  chat transcripts; actual worker capability request, monitor/window inventory,
  attach/detach, snapshots and customizable logical cursor. Click coordinates
  use the displayed image and target-local bounds, not desktop origin or device
  pixel ratio guesses. Keyboard direction controls never inject OS input.
  Applying appearance or moving the cursor requests fresh cursor-baked pixels.
- Client lifetime: pinned server/account incarnation, encrypted key revision and
  preview lease; validated AEAD scope/chunks/result binding; cleared temporary
  buffers and revoked object URLs. Close affects only this observer. Account
  switching cancels/clears it; encryption lock clears pixels but preserves Stop.
  Stop bypasses an in-flight operation and retains its exact lease on failure.
  Explicit reconnect obtains a new lease. Open/operations have a 35-second
  deadline; Stop has an independent 30-second deadline. No polling/replay added.
- Multiple observers reuse one serialized native session per preview lease;
  repeated panel reopen no longer allocates new sessions until capacity is hit.
  Scope validation remains in the worker service. Failed/cancelled native state
  is not silently replaced; explicit Stop/reconnect is the recovery path.
- Existing durable approvals are reached through **Review approval in chat**;
  reopening and retrying remain user actions. The generic API client gained an
  opt-in authenticated lifetime binding so delayed 401/CSRF responses from a
  previous account cannot sign out or replay work into the new account. Existing
  unbound API semantics remain unchanged.
- Validation: 610 focused tests pass (protocol 68, crypto 24, worker 224,
  server 149, client 145). The two explicit PostgreSQL authority tests skip
  without their isolated database URL and remain a dedicated CI job. New real
  app-client → Fastify → worker → Rust fake integration verifies cursor pixels,
  20 shared observers, encrypted non-YOLO approval and explicit retry. App,
  worker and server typechecks/builds pass. Full worker: 1,239 passes and 14
  expected skips; full app: 2,216 passes, 3 skips and the one reproduced settings
  baseline failure below. Server boundary audit and large-file check pass.
  Rust 50 tests, CUA script 30 tests, Clippy and touched-file formatting pass.
  PR/CI results are recorded when observed.
- Browser QA: actual product panel through encrypted fixture routing and real
  fake subprocess. Observed 640 × 360 monitor and 320 × 200 window images;
  arrow/crosshair/ring/dot, RGBA, size, label, trail, image click, Stop and explicit
  reconnect. At 390 × 844, dialog client/scroll width both 345; image
  279 × 174.375 preserves aspect ratio. Invalid size 97 disables Apply; 8 works.
  QA report: 7 pass checkpoints, 50 informational events, no failures. Synthetic
  keys/pixels only; no production profile/key, TCC prompt or native capture.
- Known baseline failures reproduced on unchanged Primary: account settings
  search expects removed `project-membership`; decomposition budgets are exceeded
  by `chat-turn-runtime.ts` (2124 vs 1999) and `task-routes.ts` (2149 vs 1999).
  These join earlier whole-suite gaps for the final hardening cycle; they are not
  bypassed or reported as green. Existing build chunk-size warnings remain.
- Platforms: responsive browser QA on local macOS; shared desktop/browser client
  code, portable fake tests. Packaged Tauri, iOS/Android and real macOS capture
  remain unverified. No direct Tauri invocation or RemoteDesktop change.
- Remaining first tranche: production macOS inventory/capture, bounded persistent
  JS/managed MCP with actual agent identity, preview/MCP session coordination,
  protected Trajectory, standalone release signing, full regression/performance
  and native installed/packaged verification. Native input, Accessibility,
  clipboard/files, other native platforms, custom cursor assets, continuous
  video and cross-worker control remain deferred.

### Tranche cycle 7 — macOS target inventory and native snapshots

- Branch: `codex/cua-07-native-capture`, based on merged cycle 6 (`86322d280`).
  [PR #1743](https://github.com/ArcaneArts/Cantrip/pull/1743), implementation
  commit `6f913c84357aeade38427a6ed5caba31fe1a6276`, ledger commit
  `c22ad19b9e207bc01a0ea0161373da3343d224f0`; squash-merged on
  2026-09-05 as `76d8baa7ce235c529088f26c49b49892b85be2d5`. All four CUA
  macOS/Windows/Linux/PostgreSQL jobs and twelve managed-web-runtime jobs passed.
  Primary fast-forwarded cleanly; the cycle worktree and branch were removed.
- Current work: ScreenCaptureKit backend, explicit bounded-inventory disclosure,
  portable fake/default-handshake tests, and fixture-owned native capture QA.
- Native QA exposed and fixed a real helper crash: `CGS_REQUIRE_INIT` asserted
  because CoreGraphics had not been initialized before constructing a window
  filter. Public `CGMainDisplayID()` now initializes it on the original main
  thread; its return value does not gate capture. A prior zero-frame validation
  patch alone did not fix the assertion. Empty/invalid native rectangles are
  still rejected before creating a filter, with a focused regression test.
- The same signed development helper now enumerates real targets and produces
  a decoded 1920 × 1080 monitor snapshot in the actual product panel through
  the encrypted client/server/worker fixture route. Custom crosshair, RGBA,
  size, label, trail and logical movement produced subsequent snapshots.
  No production account, encryption profile or server database was changed.
- The owned native fixture exposed a separate short-pipe-read issue: Foundation
  waited to fill the pipe read, preventing short control messages from being
  handled. Bounded POSIX reads fixed it; all 13 explicit fixture IPC checks pass.
  Cross-process window capture still returns ScreenCaptureKit `-3811` and the
  occlusion matrix is not verified. AppKit initialization, minimal capture
  settings and explicit asynchronous input retention did not resolve that error.
  The input-retention fix remains for correct native object ownership; unrelated
  configuration experiments were removed.
- A fixture-only diagnostic independently confirmed WindowServer reports the
  inactive fixture as 288 × 216 while AppKit reports 320 × 240. The decisive
  subsequent check was `CGSessionCopyCurrentDictionary`: `screenLocked=1`.
  ScreenCaptureKit itself returned zero displays, not a display rejected by our
  catalog. Fixture activation experiments were removed; the user was asked to
  unlock the desktop for further native QA. This is diagnostic evidence, not a
  new lock-state preflight in production. No lock-screen or permission bypass,
  automatic permission reset, identity switch or monitor fallback was added.
- Inventory now reads native metadata without constructing filters for every
  unrelated window. It checks cancellation between entries and reports a bounded
  nominal 1x inventory raster; selected capture alone creates a filter and
  refreshes actual output geometry and scale. This reduces unnecessary native
  work; it is not claimed as the cause of the locked-session capture failure.
- Failed native, transport, decryption/schema and image-creation snapshots clear
  old preview pixels without replay. An older cancelled request cannot clear a
  newer observation. Focused controller/component tests: 32 passed.
- ColorSync display UUID is optional additional incarnation evidence, not a
  prerequisite for capturing a valid native display. A registry regression
  verifies metadata stability and disappearance invalidation without a UUID.
- Local validation: 66 Rust tests; formatting and all-targets Clippy with denied
  warnings; 43 script tests (one explicit GUI test skipped); 641 focused
  protocol/crypto/worker/server/client tests (two PostgreSQL checks reserved for
  dedicated CI); app/worker/server typechecks and builds. Release helper install,
  strict Apple Development signature verification, equal designated requirement
  across rebuilds, and the installed executable's actual fake smoke passed.
  Equal signing requirements do not establish native permission continuity.
- Manual QA artifact ledger records five pass checkpoints, one native-window
  failure and one locked-desktop warning. Existing full-suite failures remain
  recorded under cycle 6/final hardening; no failing native QA is reported green.
- Native permission denial, target closure, Retina, complete occlusion coverage,
  release rebuild and permission continuity are not yet verified. The earlier
  three-monitor route checks decoded 1920 × 1080 PNGs and exercised negative
  origins; they did not independently verify desktop pixel content. All three
  observed native monitor scale factors were 1, not Retina evidence.
- Remaining first tranche: native capture verification, managed MCP/persistent
  JS, preview/MCP coordination, protected Trajectory, release signing and full
  regression/performance verification. Later-tranche deferrals are unchanged.

### Tranche cycle 8a — Runtime execution lifetimes and preview isolation

- Branch: `codex/cua-08a-execution-lifetimes`, based on merged cycle 7
  (`76d8baa7c`). [PR #1744](https://github.com/ArcaneArts/Cantrip/pull/1744),
  implementation commit `0aa1b1e1b8e1387a00b5109b55930f7ee8c90664`.
  Ledger/CI commits `0fa652c0b` and `eea02a1fc`; squash-merged on
  2026-09-05 as `42fa6e9b076718fffbff0d8a0e9a74f575ebdaac`.
  Primary fast-forwarded cleanly; the cycle worktree and branch were removed.
- Scope: runtime-derived root/child execution ownership and cancellation, plus
  preview-specific teardown that cannot revoke a different agent lifetime.
  Managed MCP activation and the bounded Rust JavaScript engine are subsequent
  independently mergeable parts of cycle 8, not implemented by this entry.
- Exact-scope service cancellation now treats null task/thread/turn IDs as
  values, not wildcards. Approval revocation can release one authority signal,
  including its pending requests, grants and completed-response records.
  Ordinary preview teardown releases only its native scope and signal;
  explicit Stop, trusted policy/placement changes and chat interruption retain
  their intentional chat-wide cancellation. A stale Stop cannot cancel a newer
  lease. Actual Rust fake-backend tests verify a same-chat agent session remains
  usable after ordinary preview cleanup.
- The runtime resolver is read-only: it derives root/child ancestry from native
  runtime ownership and does not invent account, server, task or execution-lane
  identity. Only native turn starts establish cancellation lifetimes; caller
  claims and telemetry cannot create authority. Terminal, interruption,
  replacement and process shutdown cancel captured signals.
- Event-ordering regressions are fixed alongside that ownership primitive:
  delayed old completions/start acknowledgements cannot cancel or rewind a newer
  root/child turn, genuine new child starts advance UI activity, and obsolete
  asynchronous workspace/reconciliation/goal reads cannot overwrite the new
  turn's state. Native thread closure/unloaded/error events end the current
  thread lifetime even without a turn-completed event; those native statuses
  carry no turn ID and are explicitly treated as thread-level authority.
- Pre-activation requirement: the upcoming MCP coordinator must register every
  active agent lifetime, including YOLO without an approval or preview record,
  and receive trusted Stop/policy revocations directly. Session cancellation
  alone must not allow that still-live execution to open another session.
- Local validation: 755 cross-boundary tests passed (76 protocol, 24 crypto,
  348 worker including 23 new runtime-lifetime tests, 149 server and 158 client);
  two PostgreSQL cases remain dedicated-CI checks. Seventeen additional runtime
  regression tests, 66 Rust tests, Rust formatting/strict Clippy, 43 script tests
  (one explicit GUI test skipped), worker typecheck/build and diff/format checks
  passed. The root CUA test command now includes runtime-lifetime and existing
  app-server/subagent regression suites; native-CUA CI path filters include
  their source and tests. Actual helper tests used the fake
  backend; no native capture or permission changes occurred in this cycle.
- Platform status: macOS/Linux portable CI and PostgreSQL CI passed. Windows
  compiled the helper and passed the new lifecycle/CUA tests, but six existing
  app-server test expectations failed because they hard-coded Unix absolute
  paths or separators. Those tests were newly included in the CUA matrix by
  this pass. GitHub accepted `--auto --squash` immediately because these checks
  are not required merge rules; the failure was observed after the merge request.
  Cycle 8a2 fixes the fixtures before further product integration. For subsequent
  passes, wait for all running CI results before requesting auto-merge; no
  repository protection setting was changed. Existing whole-suite baseline gaps and
  release/manual checks remain final-hardening work, not claimed green here.
  Unlocked native window/occlusion QA remains outstanding;
  the desktop was confirmed locked during cycle 7 and the user was asked to
  unlock it. No native permission or lock-setting changes are authorized here.
- Later-tranche input, Accessibility, clipboard/files, other native platforms,
  continuous video and cross-worker control remain deferred.

### Tranche cycle 8a2 — Portable runtime regression fixtures

- Branch: `codex/cua-08a2-portable-runtime-fixtures`, based on merged cycle 8a
  (`42fa6e9b0`). [PR #1745](https://github.com/ArcaneArts/Cantrip/pull/1745),
  implementation commit `afb9e7c50f7e8f94735f72848ea9fcfed0cf49d8`.
  Merged at 2026-09-05T03:43:41Z as
  `2767e948ab407b96df1d8643e8d18c689fd8dda8`.
- Correct six pre-existing runtime test expectations to use the host's native
  resolved root and path separators, matching the unchanged runtime's Node
  path semantics. Preserve exact sandbox roots, policy flags, file previews and
  all enabled tests. No production behavior or CI skip is changed.
- Local validation: 102 focused runtime tests and the full 755-test CUA
  boundary matrix passed; two PostgreSQL cases remain dedicated-CI checks.
  Worker typecheck, changed-file formatting and diff checks passed.
  Actual Windows/macOS/Linux and PostgreSQL CI all passed on the final PR head
  before squash auto-merge was requested. Primary was fast-forwarded and only
  this cycle's clean worktree/branch were removed. Managed MCP,
  JavaScript, native unlocked-window QA, Trajectory and final hardening remain
  first-tranche work; all later-tranche deferrals remain unchanged.

### Tranche cycle 8b — Bounded JavaScript and worker-authorized host calls

- Branch: `codex/cua-08b-bounded-javascript`, based on merged cycle 8a2
  (`2767e948a`). [PR #1746](https://github.com/ArcaneArts/Cantrip/pull/1746),
  implementation commit `09a4cab1b657cf748eef47792e15cadbded1762e`.
  Merged at `2026-09-05T04:21:45Z` as
  `fb0111e2ab5eb024061105dcbe02f99cd9397cdc`. Primary fast-forwarded;
  only the cycle-owned worktree and branch were removed.
- Scope: persistent, bounded Rust JavaScript contexts and a payload-free host
  rendezvous through the existing worker-owned process. No managed MCP tool is
  enabled in this pass. Native input, filesystem, network, clipboard and extra
  platform capture remain excluded.
- Worker contexts bind to the exact canonical server/account/worker/chat/task/
  thread/turn and actual runtime lifetime signal. The worker retains validated
  PNG bytes outside JavaScript, authorizes each supported host action, and
  tracks lifetime revocation independently from preview/native-session/approval
  existence. Reset disposes variables and attachment, not turn authority.
- Implemented the frozen observation/cursor API with top-level await and lexical
  persistence using pinned `rquickjs 0.12.2`. Four engines have bounded heap,
  stack, source, result, host-call, job, active-execution and wall-time budgets.
  Finalizers, shared-memory waits and ambient I/O are unavailable. Idle engines
  block on commands; native capture remains on its existing executor. No script
  or serializer may leave jobs/host calls for a later evaluation.
- Reset acknowledgments retain capacity until cleanup actually completes;
  transport reserves 20 cleanup slots alongside 16 ordinary correlations.
  Late attachments close their orphaned native session. Failed/canceled or
  over-budget snapshots are cleared from worker buffers. Per-call cancellation
  disposes state without accidentally revoking the whole still-live turn.
- Local validation: 815 CUA boundary tests passed (76 protocol, 24 crypto,
  408 worker, 149 server, 158 client); two PostgreSQL cases await dedicated CI.
  The worker count includes 36 JavaScript ownership/process/lifecycle cases and
  43 framing/transport cases. All 79 Rust tests passed, including ten real-child
  JavaScript tests; strict all-targets Clippy and Rust formatting passed.
  Script tests: 43 passed, one explicit native-GUI skip. Worker typecheck/build,
  release Rust build and exact-release-binary fake smoke (eight snapshots, all
  cursor styles), changed-file formatting and diff checks passed.
  Initial cross-platform CI stopped at a Rust 1.95 `collapsible_match` lint;
  PostgreSQL passed. Follow-up `b9058e55993cbef5c47453df1fa3271536510daa`
  uses the equivalent match guard. Local strict Clippy and all 79 Rust tests
  also pass on the exact CI toolchain, 1.95.0. Final-head CI run `33944184455`
  passed macOS, Windows, Linux and PostgreSQL before auto-merge was requested.
  Real native unlocked-window QA remains pending;
  this pass does not request Screen Recording or change helper identity. The
  subsequent managed-MCP pass must connect actual turn provenance, durable
  approval waits, cancellation and protected image redaction before activation.
- Remaining first-tranche work: managed
  MCP, protected Trajectory, native/window/release QA and final hardening.
  Later-tranche deferrals remain unchanged.

### Tranche cycle 8c1 — Current agent authority, approval waits, and image redaction

- Branch: `codex/cua-08c1-agent-authority`, based on merged cycle 8b
  (`fb0111e2a`). [PR #1747](https://github.com/ArcaneArts/Cantrip/pull/1747),
  implementation commit `ecea7a7690de4d0f7a0f7c8dc8e1d9be618589ab`.
  Squash-merged at `2026-09-05T04:50:16Z` as
  `08dd5919c8ca8cd31f25142f16aea45d7107bac7`. All four macOS, Windows, Linux
  and PostgreSQL jobs passed in CI run `33945484818` before auto-merge.
  Primary was synchronized and the clean cycle worktree was removed.
- Scope: prerequisites for managed MCP activation. The server exposes a
  worker-authenticated CUA authority route using the existing agent-tools
  credential scope. Every request reads current durable placement and selected/
  effective policy. It does not accept client policy claims, follow another lane,
  infer a native turn from server UI status, cache permission, or probe native
  readiness. The worker client snapshots its attachment before awaiting the
  response and composes caller cancellation with a bounded request deadline.
- Approval waits resume the original suspended action after its exact protected
  request is published and approved. Denial, expiry, publication failure,
  revocation and per-call cancellation settle it without replay. A raced approval
  cannot leak a grant from a failed publication. Stop does not consume a waiter.
  Existing preview approval/retry remains a separate, preserved path.
- Raw Trajectory capture omits nested MCP image and typed-binary payloads while
  leaving the actual model result unchanged. Ordinary text is not classified as
  image data merely because it resembles base64. No second pixel audit store.
- Activation: no agent-facing tool is enabled by this cycle. The next pass must
  connect the actual root/child runtime turn, all-lifetime Stop/revocation,
  dedicated durable event publication, MCP metadata/cancellation, model-sized
  image output and CUA-only approval-compatible deadlines before activation.
- Validation: 885 focused CUA boundary tests passed (76 protocol, 24 crypto,
  457 worker, 170 server, 158 client); two PostgreSQL cases await dedicated CI.
  The server cases include the real worker HTTP authority client. All 552
  protocol tests and 79 Rust tests passed; Rust 1.95 strict all-targets Clippy
  and formatting passed. Script tests: 43 passed, one explicit native-GUI skip.
  Worker/server typecheck and builds, changed-file formatting, large-file and
  diff checks passed. The reviewed server boundary inventory adds only the
  credential-protected authority route and its metadata classification; its
  regenerated audit passes. Review found and fixed publication/admission and
  final-response cancellation races with deterministic regressions.
- Platform/manual: portable fake execution passed on macOS, Windows and Linux;
  PostgreSQL authority CI passed. Local native execution in this pass uses the
  deterministic fake backend, not unlocked-window capture.
  No Screen Recording prompt, native GUI action, helper identity change or
  new native platform support is part of this pass. Existing unlocked-window,
  packaged signing/permission continuity and final regression work remain open.
- Remaining first-tranche work: managed MCP activation and end-to-end tests,
  protected operation Trajectory, native/window/release QA and final hardening.
  Native input, Accessibility, human event taps, clipboard/filesystem mutations,
  other native operating systems and cross-worker control remain deferred.

### Tranche cycle 8c2 — Managed MCP activation and model images

- Branch: `codex/cua-08c2-managed-mcp`, based on merged cycle 8c1
  (`08dd5919c`). This is the recovered interrupted worktree.
  [PR #1748](https://github.com/ArcaneArts/Cantrip/pull/1748), implementation
  commit `8087c9c2`, ledger commit `772d4cb1c`, and Windows fixture correction
  `5e03389c5`. Squash-merged at `2026-09-05T10:46:25Z` as
  `281a4a1732a0d005fc633bf6b04959c3d75d5beb`. Final CI run `33961418395`
  passed macOS, Windows, Linux and PostgreSQL before auto-merge was requested.
  Primary was synchronized; the clean cycle worktree and local branch were removed.
- Implemented: dedicated worker-managed `cantrip_cua` tools `js` and `js_reset`
  through the existing authenticated broker and sole `CantripCuaService` owner.
  Actual Codex thread/turn metadata selects an observed root/child lifetime;
  tool arguments cannot invent execution authority. Protected chat and direct
  Task contexts receive the managed host. Older dispatches without trusted CUA
  authority retain ordinary behavior without that host. Host startup does not
  launch Rust; the first actual operation performs the required handshake.
- Current authority: server dispatch carries the durable generation and selected/
  effective profile, including whether the selection inherits the default.
  Both project and standalone lane acquisition return that real generation.
  Every operation refreshes authority through the authenticated server route;
  host actions recheck it after approval. Stop/revocation fences a registration
  before its first call and after reset, including YOLO with no approval record.
  Child teardown uses actual runtime ancestry and preserves unrelated roots.
- Durable approvals use the existing protected computer-use interaction owner
  and the originating command stream. Terminal events follow request insertion,
  and the server validates chat/worker/project/lane provenance without rewriting
  the native thread or routing the reply to Codex CLI approvals. Failed terminal
  publication cannot permanently retain registration capacity.
- Images: actual MCP image blocks, strict PNG/digest/dimension validation, two
  images and 16 MiB aggregate native input. Valid PNGs up to 2.5 MiB are preserved;
  larger images resize once to at most 600,000 pixels, without crop/enlargement.
  Model output is bounded at 2.5 MiB/image, 5 MiB total and the actual 8 MiB MCP
  JSON-RPC line. Native metadata stays separate from model rendition dimensions.
  Four encoder jobs retain their capacity through cancellation until native work
  settles. Temporary byte buffers are cleared; raw Trajectory still omits pixels.
- Deadlines: CUA-only trusted 345-second JS wall budget permits the five-minute
  approval wait, within 360-second broker and 370-second Codex tool deadlines.
  The two-second active JS budget remains unchanged. Generic MCP retains its
  512 KiB/55-second limits; worker-internal JS defaults to 45 seconds.
- Local verification: 995 focused CUA boundary tests passed (96 protocol,
  24 crypto, 535 worker, 182 server, 158 client); two PostgreSQL tests remain
  dedicated-CI checks. Actual compiled Rust -> worker coordinator/service ->
  authenticated broker -> real MCP stdio returns decoded PNG images and proves
  persistence/reset, root/child isolation, encrypted approval/denial, stale
  authority and Stop. The real PGlite dispatch harness verifies selected/inherited
  policy and both project/standalone acquired generations. All 572 protocol,
  85 Rust, and 44 CUA script tests pass; one explicit GUI script test skips in
  the ordinary runner. Strict Rust 1.95 Clippy/format, worker/server builds and
  typechecks, release build and exact-release fake smoke (eight snapshots, four
  cursor styles), route-boundary audit and large-file check pass. Real Sharp tests
  cover aggregate input/output bounds and cancelled-job capacity; packaged
  verification resolves Sharp from the final worker dependency layout.
- CI correction: the initial Windows run exposed a test-only `file:///worker`
  URL without a drive letter. The fixture now builds its URL from the host's
  resolved path. Production transport behavior and assertions are unchanged;
  the final four-job run above passed with that correction.
- Broad worker run: 1,443 passed, 36 skipped, three goal-streaming failures.
  The same three failures reproduce on unchanged Primary `08dd5919c` and in
  the branch's isolated goal-streaming file; no whole-worker green claim.
  App decomposition still exceeds the recorded baseline budgets:
  `chat-turn-runtime.ts` is now 2,156 lines (Primary 2,124; budget 1,999), and
  unchanged `task-routes.ts` is 2,149. These remain final-hardening work.
- Native retry: the existing Apple Development-signed stable
  `cua-cycle-three-qa` helper completed handshake/inventory but its first owned
  fixture-window snapshot was reported as `native-operation-failed` by the QA
  wrapper. A subsequent fixture-only diagnostic decoded the correct foreground,
  partially/fully occluded, moved and resized fixture pixels; it exposed the
  wrapper's initial geometry mismatch and then an immediate post-close assertion.
  Native error callbacks did not report a capture error in that run. The current
  session reports on-console/login-complete with no screen-locked key. This is
  positive native pixel evidence, not a completed lifecycle/permission-continuity
  matrix. No privacy setting or signing identity was changed. Fixture/native
  lifecycle timing remains under investigation for the native acceptance pass.
- Remaining required tranche work: preview/MCP observation coordination,
  protected per-operation Trajectory, native occluded-window/product acceptance,
  release identity/permission checks, performance measurements and final
  regression/completion audit. Native input, Accessibility, clipboard/files,
  human event taps, other native platforms, continuous video and cross-worker
  control remain deferred. The full roadmap below remains unfinished.

### Tranche cycle 8d — Native fixture acceptance and coordinate precision

- Branch: `codex/cua-08d-native-acceptance`, based on merged cycle 8c2
  (`281a4a173`). [PR #1749](https://github.com/ArcaneArts/Cantrip/pull/1749),
  implementation commit `997af3731`, ledger commit `0d1f3e786`. Squash-merged
  at `2026-09-05T11:09:36Z` as `38da8c6e53e8039dd24c8bb972546ce6eae85d67`.
  CI run `33962408503` passed macOS, Windows, Linux and PostgreSQL before
  auto-merge. Primary was synchronized; the clean cycle worktree/branch removed.
- Native acceptance exposed a real protocol precision defect: the default JSON
  parser changed certain fractional logical coordinates by one IEEE-754 ULP.
  Enable `serde_json`'s maintained `float_roundtrip` feature. A regression sends
  independently constructed fractional values through the actual framed
  executable and checks exact bits in both cursor and snapshot responses. It
  failed before the change and passes afterward; strict smoke assertions remain.
- Fixture ownership diagnosis: an autoreleased `orderedWindows` array created
  before AppKit's event loop retained a closed target for the fixture process's
  lifetime. An initialization autorelease pool drains that temporary ownership.
  Native state also changes asynchronously after AppKit resize/close calls;
  the fixture's acknowledgment must reflect its own actual WindowServer state.
  This is test-fixture synchronization, not a production readiness gate.
- Verification: all 86 Rust tests, strict Rust 1.95 Clippy/format, and
  995 focused CUA boundary tests pass (96 protocol, 24 crypto, 535 worker,
  182 server, 158 client). Two PostgreSQL tests remain dedicated-CI checks.
  Local platform is macOS 27.0 build 26A5421a, arm64. Native fixture verification
  uses the installed Apple Development-signed `cua-cycle-three-qa` helper,
  synthetic accounts/keys, and fixture-owned window pixels only.
- Native fixture: all six scenarios pass on installed debug and release builds:
  foreground, partial/full occlusion, move, resize and recreation, plus strict
  old-target rejection after close. Decoded color patches verify the selected
  window rather than the blue occluder; all four logical cursor styles are
  exercised. Initial captures are 320 × 240; resized captures are 384 × 288.
  All 14 opt-in fixture tests pass. Ordinary CUA script tests: 45 pass and one
  explicit GUI skip. No screenshot file is saved.
- Added an opt-in native app-client -> Fastify -> worker coordinator/service ->
  installed Rust test. It passes once with each signed debug/release build,
  verifying foreground and fully occluded fixture pixels, exact geometry,
  the logical cursor's decoded pixel, protected metadata/image delivery and
  Stop releasing the session/preview/approval state. The ordinary runner skips
  it unless `CANTRIP_CUA_NATIVE_TEST_BINARY` is explicitly provided. This uses
  actual production route/client/service implementations with synthetic endpoint
  dependencies; it does not prove live-account UI or packaged Tauri acceptance.
- Development identity: replaced the installed debug helper with the distinct
  release binary at the same named-profile path. Strict codesign verification
  and installed fake smoke passed; both builds have identical designated
  requirements (`art.cantrip.cua.dev`, Apple Development certificate). Both then
  completed native fixture and protected-route capture without a permission
  response or privacy-setting change between installs. Prompt presentation was
  not independently observed; this is successful native capture across changed
  development builds, not proof of outer-app/release update permission reuse.
- Timing samples: debug fixture smoke 2,738 ms total, first snapshot 233 ms,
  subsequent snapshots 138–158 ms; release 2,682 ms total, first snapshot 229 ms,
  subsequent snapshots 146–151 ms. These single fixture runs include native
  capture/encoding/IPC and verification, not an isolated transport benchmark or
  performance improvement claim. Warm/cold/idle/startup measurements remain.
- Remaining required tranche work: preview/MCP observation coordination,
  protected per-operation
  Trajectory, standalone release signing and packaged update/permission checks,
  actual `pnpm devtop` acceptance, performance measurements, and final regression
  and completion audit. Later-tranche deferrals remain unchanged.

### Tranche cycle 8e — Observe completed agent images from the shared preview

- Branch: `codex/cua-08e-agent-preview`, based on merged cycle 8d (`38da8c6e5`).
- PR: [#1750](https://github.com/ArcaneArts/Cantrip/pull/1750).
  Implementation commit: `f53c20822e084ca797ab5b615fd5c480bdf44a39`.
  Squash auto-merged 2026-09-05 at 11:54:42 UTC as
  `c9e516f51497debab6bdf536d4c9a0fc8e00ca4b` (observed via GitHub).
  CI run `33964194801` passed macOS, Windows, Linux and PostgreSQL on final
  head `9e784dd963a93b82e962032c046105fc0db1e2d1`. Primary was fast-forwarded;
  this pass's clean worktree and squash-merged local branch were removed.
- Implemented: **Manual preview** / **Follow agent** in the existing shared
  responsive panel. Follow agent lists actual root/child execution sources and
  retrieves their latest completed observation through the same protected
  app/server/worker route. It displays worker, thread, turn, session, target and
  observation attribution. Manual target/cursor controls are unavailable in
  this read-only view; the rendered model image already contains its cursor.
- Worker ownership: the existing coordinator references only the latest
  immutable model-image string from each active execution, at most four total.
  The image is not recaptured, resized again or saved in a second store. Original
  native metadata remains separate from model rendition dimensions/digest.
  Source IDs are opaque per-completed-evaluation UUIDs, scoped to exact current
  owner/server/worker/chat/project/placement/generation/profile and real native
  thread/turn/session. Client source claims never authorize native operations.
- Lifecycle: next evaluation, reset, error, native helper loss, request cancellation, Stop,
  revocation, disconnect and actual turn/command completion retire sources.
  Publication epochs reject late encoder completions. Source retirement aborts
  a reader already encrypting its copied image, including between accepted
  encrypted chunks and the final manifest. Four global decoded-reader slots
  are reserved before base64 decoding and remain held until actual delivery
  cleanup, even after cancellation. Temporary bytes are cleared on settlement.
- Observation reads use current authenticated preview authority and existing
  policy projection. They read already-authorized agent results without an
  additional capture prompt or native operation. Original agent capture approvals
  remain mandatory where selected policy requires them. Ordinary observer close
  and mode changes preserve the agent; explicit Stop remains chat-wide and
  independent from a pending approval or image read.
- Verification: 1,057 focused CUA tests pass (103 protocol, 25 crypto,
  559 worker, 194 server, 176 app). Three explicit skips are the two PostgreSQL
  cases reserved for dedicated CI and the opt-in native fixture route. Ten
  new compiled Rust -> actual MCP broker/stdio -> encrypted Fastify route ->
  app-client tests verify exact image bytes/digest/revisions, decoded cursor
  pixels at negative desktop origins, two observers, root/child isolation,
  real reset/next-evaluation/completion/Stop and foreign-authority rejection.
  Deterministic blocked-publication races prove source invalidation and reader
  capacity through cleanup. Killing the test-owned Rust helper after an accepted
  encrypted chunk aborts copied-image delivery and clears its bytes without
  another list/read or implicit restart; the observer lease remains usable.
  Worker/server/app builds and app typecheck pass.
- Browser QA: the actual shared panel/controller with a synthetic endpoint and
  Rust fake-backend images passed root/child attribution, source retirement,
  mode switch, delayed-read cancellation, Stop, encryption change and observer
  reopen checks. The cursor appears once in the image. Six layout checks passed
  (1150 px and 358 px content widths, matching scroll widths). Structured logs
  contain 33 pass events and no failures/warnings, including nine byte-cleanup
  checks, two of them aborted late reads. This proves panel behavior, not a
  physical mobile device or live-account/native route. Reproducible harness and
  logs are retained outside the checkout at `/tmp/cua-08e-qa-evidence`.
- Repository-wide `pnpm check` ran and stopped at existing decomposition
  budgets: `chat-turn-runtime.ts` has 2156 lines and `task-routes.ts` 2149, each
  above 1999. Both files are unchanged and have the same counts at the base
  commit. Later steps of that chained command did not run; focused checks above
  are separate evidence. Full protocol suite: 606 tests pass.
- Platforms/manual: local macOS fake backend for these tests; native fixture
  acceptance remains the separately verified cycle 8d evidence. Portable CI
  passed as recorded above; no native capture or privacy/signing changes
  are part of this pass. Live `pnpm devtop`, packaged Tauri, mobile-device and
  native MCP/observer product acceptance remain final verification work.
- Remaining tranche work: protected per-operation Trajectory, standalone release
  signing, installed/packaged update and permission evidence, startup/idle/latency
  measurements, live product acceptance, and the final regression/completion
  audit. The full roadmap and later-tranche deferrals below remain unchanged.

### Tranche cycle 9 — Protected per-operation Trajectory

- Branch: `codex/cua-09-protected-trajectory`, based on merged cycle 8e
  (`c9e516f51`). Implementation commit: `1a3ee9f5`.
- PR: [#1751](https://github.com/ArcaneArts/Cantrip/pull/1751), final head
  `26af414ddd9b5b44ca90a5a5d5eb00402602d937`, squash-auto-merged at
  `2026-09-05T12:39:45Z` as `42c4f9c0cf6709a14c9750933c583b53e9befe26`.
  CI run `33966480732` passed macOS, Windows, Linux and PostgreSQL before
  auto-merge was enabled. Primary fast-forwarded cleanly; only the cycle-owned
  worktree and branch were removed.
- Implemented: actual agent MCP and user preview operations use the existing
  encrypted chat/task message and Trajectory paths. Agent records retain the
  runtime's root/child scope; idle preview sessions have a distinct Preview
  operator actor with no invented agent thread or turn. Records include bounded
  operation, timing, outcome, cursor and image metadata, never another screenshot
  copy, native inventory or JavaScript source. The server relays and stores opaque
  content through existing ownership-aware message paths.
- Lifecycle: preview payloads/readers are released before history publication.
  Stop revokes native sessions and pending work before publishing history; an
  unavailable/archived history cannot reverse Stop. Failed runtime turns release
  CUA and settle queued protected activities before returning the original error.
- Review corrections: MCP detach retains the prior target identity; rejected
  runtime turns cannot skip the protected queue; reversed/shuffled persisted
  preview messages are sorted before deriving their latest status. Actual agent
  inference progress remains separate from preview sessions.
- Browser QA: the actual shared Trajectory components passed seven synthetic
  scenario groups: root/child attribution, two-session history/back navigation,
  metadata-only tabs, failure/cancellation search and filtering, 358-pixel layout,
  actor/session labels, and matching operation identity in Raw. Evidence and a
  hash manifest are retained outside the repository at
  `/tmp/cua-09-qa-evidence/20260905-071132-verify-protected-computer-use-tr`.
  The fixture used synthetic protected activity records, not a signed-in account
  or native capture. Repeated hot-reload layout events are not separate scenarios;
  temporary harness hot-reload console warnings prevent a clean-console claim.
  The owned server and temporary harness were removed after QA.
- Verification: `pnpm cua:test:worker` passes 1,188 tests against the compiled
  Rust executable: 130 protocol, 25 crypto, 566 worker, 214 server, 253 app.
  Three explicit skips remain: two PostgreSQL tests run in dedicated CI and one
  opt-in native preview test. This includes actual MCP/preview success, failure,
  approval denial, cancellation, protected chat/task decoding, and held-sealer
  runtime-rejection tests. Full protocol suite passes 660 tests; worker, server
  and app builds, app typecheck, formatting and diff checks pass. Local execution
  is macOS arm64 with explicit fake capture. `pnpm check` stops at unchanged server decomposition
  budgets: `chat-turn-runtime.ts` 2,156 and `task-routes.ts` 2,149 lines, each with
  a 1,999-line limit; both counts match this pass's base. Later commands in that
  chained check are not claimed to have run. Native product, packaged Tauri and
  physical mobile acceptance are not established by this pass's fixtures.
- Remaining tranche work also includes standalone release signing,
  installed/packaged update and permission evidence, startup/idle/latency
  measurements, live product acceptance and final regression/completion audit.

### Tranche cycle 10 — Standalone Darwin helper release signing

- Branch: `codex/cua-10-worker-release-signing`, based on merged cycle 9
  (`42c4f9c0c`). Implementation commit: `f797d21c`.
- PR: [#1752](https://github.com/ArcaneArts/Cantrip/pull/1752), final head
  `d36e3c6b38d77feb87c731ffdf61a16dc2d22c78`, squash-auto-merged at
  `2026-09-05T13:06:58Z` as `0f00cdfc87f80df6d2baffc43ee7accfcd69ada0`.
  CI run `33967804926` passed macOS, Windows, Linux and PostgreSQL before
  auto-merge was enabled. Primary synchronized cleanly; only the cycle-owned
  worktree and branch were removed.
- Implemented: the standalone Darwin worker job imports the shared Developer
  ID certificate, signs its final CUA executable before verification/archival,
  and checks its actual signature, stable identifier, Developer ID authority
  and hardened runtime before final-layout helper/Sharp smoke. Desktop and
  worker jobs share the existing import behavior; cleanup only owns a keychain
  after successful creation and preserves existing keychains/default selection.
- Local verification: 83 signing, workflow, importer and CUA script tests pass;
  one explicit GUI test is skipped. Importer tests execute the actual Bash
  script with synthetic signing tools/credentials; they do not prove real CI
  certificate availability. Initial CI passed macOS, Linux and PostgreSQL but
  exposed three Windows workflow-test CRLF assumptions. The shared test reader
  now normalizes line endings; all 12 workflow tests pass with LF and actual CRLF
  copies, while the original CRLF copy reproduced the three failures. Bash
  syntax, formatting and diff checks pass. `pnpm check` again stops at the
  unchanged server decomposition budgets recorded in cycle 9; no later chained
  check is claimed.
- Actual artifact verification on macOS arm64: the real
  `pnpm package:worker --target darwin-arm64` completed, including bundled Codex
  and Cantrip Code. Its final CUA helper was signed with
  `Developer ID Application: Arcane Arts Inc. (RK2CYG6XRV)`; codesign reports
  `art.cantrip.cua`, hardened runtime and a secure timestamp, with no JIT
  entitlements. Signature validation and real final-layout helper/Sharp smoke
  passed both before and after the real worker archive was extracted. The
  extracted worker MCP smoke also passed. Signed helper SHA-256:
  `16dfa9d20b64540a5c8315cc5cc36a5f9a12e40b74f96b809f4080ee54761f87`;
  worker archive SHA-256:
  `050f457eac1e924558e2818b256165bc20a9edca7ac1f7421b4bfbd2b1a27377`.
- Native artifact attempt: the extracted signed helper captured and pixel-verified
  the owned fixture's foreground, partial/full occlusion, movement and resize
  states on a repeated run. This is not a complete fixture pass: the first run
  returned `requested-target-unavailable` initially, and the repeated run returned
  it after window recreation. A paired inventory probe between runs found the
  fixture for both release and installed-development helpers. Newly created
  fixture visibility remains an acceptance investigation; no permission cause,
  stable repeatability or packaged-app update authorization is inferred.
- These local artifacts are not a dispatched release or standalone-worker
  notarization. CI certificate import, enclosing app/DMG notarization and actual
  installed update permission behavior are not established by helper signing.
- Native/product acceptance, installed/packaged update permission continuity,
  performance measurements and final regression/completion audit remain required.

### Tranche cycle 11 — Bounded native inventory pagination and acceptance

- Branch: `codex/cua-11-native-acceptance`, based on merged cycle 10
  (`0f00cdfc8`). Implementation commit: `bfceee05c531022fd74e863542c992d1b0cf761d`.
- PR: [#1753](https://github.com/ArcaneArts/Cantrip/pull/1753), final head
  `80e6fc28b36971ad85b9253ceda69dc81383acfb`, squash-auto-merged at
  `2026-09-05T13:50:24Z` as `149010e9fc22817dbc867b1863d531b9c0d9c48f`.
  CI run `33969829006` passed macOS, Windows, Linux and PostgreSQL before
  auto-merge was enabled. Primary synchronized cleanly and the cycle-owned
  worktree/branch were removed. Owned QA profile/build state was preserved
  outside that worktree for the follow-up application walkthrough.
- Native finding: a fresh actual probe returned 224 targets from 473 native
  windows plus three displays, rejected 24 invalid capture rectangles, and
  omitted the owned fixture through initial, covered, closed and recreated
  states. The old inventory budget was applied before sorting, and attachment
  searched the same first page. Refreshing did not provide a discovery path.
- Implemented: native inventory selects a bounded lexical page before applying
  its byte budget. `targets.list` and managed `cua.targets({after})` expose the
  next cursor through existing protected payloads. Each target array is at most
  31 KiB, reserving room inside the unchanged 32 KiB JavaScript result limit;
  existing native/MCP transport ceilings remain unchanged. At most 257 candidate
  metadata records are retained while walking native arrays. Exact attachment
  refreshes a previously discovered ID/generation independently of the public
  page; page omissions and temporary invalid geometry do not retire an unchanged
  owner. Actual disappearance/replacement still invalidates the incarnation.
- Preview: First/Previous/Next and current-page refresh retain only one inventory
  page and 32 prior cursors. Browsing another page preserves the attached target,
  cursor and observation. Stop/teardown reject late page responses. The server
  remains an opaque authenticated relay; each MCP page retains effective-policy
  authorization and the existing execution lifetime.
- Fixture: discovery follows at most 64 pages/4,096 returned targets and reports
  only counts and fixture-owned matching metadata. It checks retired-target
  absence across pages and preserves actual capture failures without retries.
  An explicit fixture lifetime up to five minutes supports interactive product
  QA; the smoke default remains 20 seconds, with EOF/abort/watchdog cleanup.
- Verification: 93 Rust tests, Rust formatting and Clippy pass. Tests cover
  reverse native ordering, count/escaped-byte bounds, maximal native metadata
  through the actual JavaScript output limit, later-page attachment and native
  generation preservation/replacement. `pnpm cua:test:worker` passes 1,201 tests
  against the compiled executable: 132 protocol, 25 crypto, 569 worker, 214 server,
  261 app. Three explicit skips remain (two dedicated PostgreSQL tests and the
  separately executed native route). Full protocol passes 664 tests. Worker,
  server and app builds and app typecheck pass. CUA script tests pass 52 with
  two explicit GUI skips; the two opt-in fixture lifecycle tests were exercised
  separately on macOS. The initial standalone app build
  lacked the Glitch package output, then passed after normal dev preparation
  built that actual dependency. `pnpm check` still stops at the unchanged server
  decomposition budgets recorded in cycle 9; no later chained check is claimed.
- Native macOS arm64: normal `pnpm devtop -- --profile cua-cycle-three-qa`
  rebuilt and installed the same stable Apple Development helper identity and
  launched the server, worker, Vite and Tauri executable. The installed helper
  found the owned fixture on page four and passed all six decoded-pixel capture
  scenarios: foreground, partial/full occlusion, movement, resize and recreation,
  with old-target rejection and session shutdown. Snapshot samples were 158–397 ms
  in this run; these are smoke samples, not a comparative performance baseline.
  The actual client codec -> Fastify -> worker -> installed native helper route
  also passed its foreground/occlusion/cursor/encryption/Stop fixture test.
- Live product status: the browser opened the real local application, but its
  local encryption authorization repeatedly requested recovery acknowledgment
  and remounted before a project/chat could be opened. Read-only inspection
  identified an existing session transition bug: spreading the prior authenticated
  context after the destination recovery kind overwrites that kind and prevents
  the normal recovery setup screen. A separate pass will fix and verify that
  transition. No signed-in model or
  live preview success is claimed. Investigation is separate from the passing
  native/protected-route fixtures. Tauri executable launch is established; its
  visible Computer Use walkthrough remains unverified. No permission reset,
  identity switch, provider credential access or unrelated window capture was
  used to turn that incomplete acceptance into a pass.
- Remaining tranche work: resolve/complete live product and real managed-agent
  acceptance, enclosing packaged-app/update permission evidence, comparative
  startup/idle/latency measurements, relevant broad regressions and final audit.
  Deferred native input, Accessibility, clipboard/files, other OS backends and
  the remaining roadmap are unchanged.

### Tranche cycle 12 — Preserve encryption recovery transitions

- Branch: `codex/cua-12-recovery-transition`, based on merged cycle 11
  (`149010e9f`). Implementation commit: `1421c0c5`.
  PR: [#1754](https://github.com/ArcaneArts/Cantrip/pull/1754), final head
  `8f959570943c32d7a8b1935e6c78a6effcfad762`, squash-auto-merged at
  `2026-09-05T14:11:50Z` as `420c4f90e5c1219461e21bead0fdf19431750acf`.
  No CI workflow ran for this auth-only change; the optional check was skipped.
  Primary synchronized cleanly. Its clean worktree is temporarily retained for
  the running QA profile and development app; cycle 13 authors changes in a
  separate worktree based on the observed merge.
- Fixed the existing application session transition exposed by live acceptance:
  callers supplied a complete prior state through a structural context type,
  then its spread overwrote the destination `kind` and retained stale recovery
  fields. The transition now copies only the four shared identity fields before
  selecting the next state. Credential authorization and recovery requirements
  remain enforced; account data is not reset or replaced.
- Verification: eight of nine new transition cases failed with the prior
  semantics. All 53 focused transition, recovery-screen, account-encryption,
  workspace-encryption and client-session tests now pass across five files.
  App typecheck and production build pass. `pnpm check` again stops at the
  unchanged server decomposition budgets recorded in cycle 9; subsequent
  chained checks are not claimed.
- Actual macOS development launch: the preserved profile's moved Cargo cache
  referenced removed cycle-11 generated Tauri permissions and failed. Clearing
  only its owned Cargo target output and repeating normal
  `pnpm devtop -- --profile cua-cycle-three-qa` rebuilt Tauri in 29.32 seconds
  and launched the desktop, server, worker and Vite. Account and worker data,
  stable helper path and signing identity were preserved.
- User-observed Tauri result: the normal IDE is visible. Its empty projects and
  settings belong to this isolated QA profile. Browser result: stable anonymous
  recovery-required screen for a client without that profile's device key;
  this is expected authorization behavior, not an authenticated remount loop.
  The browser recovery import and native recovery setup walkthrough were not
  completed. Native UI automation cannot attach to the raw Tauri dev executable.
  Per user direction, broader recovery work is outside this CUA acceptance pass.
- Remaining first-tranche work: live CUA preview/managed-agent acceptance,
  enclosing packaged-app and update permission evidence, comparative performance
  measurements, relevant broad regressions and final completion audit. No new
  native capture or permission-continuity claim is made by this auth fix.
  Later-tranche deferrals remain unchanged.

### Tranche cycle 13 — First-use protected preview grants and live acceptance

- Branch: `codex/cua-13-product-acceptance`, started from cycle 12's observed
  merge (`420c4f90e`). [PR #1757](https://github.com/ArcaneArts/Cantrip/pull/1757),
  implementation commit `8a36720834757df4eee05575d6b292ca759176df`.
  Final head `d95cbb80fb4a050916d2f45fd97a86f4ff6aa98e` passed all four
  actually running macOS/Windows/Linux/PostgreSQL jobs in CI run
  `33976714131` before squash auto-merge was enabled. Observed merged
  2026-09-05 at 16:09:14 UTC as `96ac98106975a04ec0225889a33aead59c5995c9`;
  Primary was fast-forwarded cleanly. The cycle 12/13 worktrees remain owned
  by the active isolated QA profile and runtime until acceptance finishes.
- Live first use exposed a real missing prerequisite: an idle chat with no
  prior agent turn had endpoint control authorization but lacked the history
  component grant needed to publish protected CUA activity. Preview opening
  returned 200; the first operation returned 502 with a protected-publication
  failure. Existing universal-key fixtures masked the missing scope.
- Implemented: the server-validated worker lease identifies its real chat/task
  content domain. Before its first operation, the client uses existing principal
  approval and wrapped-key grants for only client control, interactions and the
  matching history domain, then performs the actual worker encryption refresh.
  Server/account/key revision, worker principal, grant recipient, scope and
  cancellation remain bound through asynchronous work. Successful preparation
  is cached only for that owned lease. Stop retains its independent path and
  can cancel preparation. No key bypass, extra permission mode or native gate.
- Regression evidence: four genuine wrapped-key server/client cases cover chat
  and task missing-history failure and successful first-use preparation with
  the real HPKE worker service. Removing client preparation makes both positive
  cases fail. Opposite-domain grants do not authorize history publication.
  Focused client tests cover cancellation, identity changes and exact principal,
  recipient, revision and scope validation.
- Local verification: `pnpm cua:test:worker` passes 1,230 tests against the
  compiled Rust helper: 133 protocol, 25 crypto, 571 worker, 220 server and
  281 app. Three explicit server skips remain (two dedicated PostgreSQL cases
  and the opt-in native fixture). Full protocol: 666 tests across 69 files.
  App typecheck/build and worker/server builds pass. `pnpm check` stops at the
  unchanged server decomposition counts 2,156 and 2,149 versus 1,999; later
  chained checks did not run. This pass does not claim whole-repository green.
- Actual macOS arm64 product acceptance: the same named QA profile, stable
  Apple Development helper and normal devtop-built native executable were used.
  A debug `.app` wrapper made that devUrl executable accessible to native UI
  tooling; the ordinary server/worker/Vite services run cycle 13 source. This
  wrapper is not production app signing, packaging or notarization evidence.
  The user configured a model directly in the isolated dev app. No credentials
  were read from files or copied into the test harness.
- Live preview: real native backend and four inventory pages; Cantrip itself
  was present on page four. Durable Workspace inventory/attachment/capture
  approvals resolved through chat and required explicit retry. The fully
  covered owned fixture rendered red with green/yellow/cyan/magenta corners at
  320 × 240. YOLO added no extra confirmation. A white translucent ring, size
  40, label `QA`, trail and logical movement appeared in subsequent snapshots.
  Expired fixture targets reported disappearance without fallback; Stop cleared
  the preview. The large untitled-window list remains awkward to navigate.
- Live managed agent: actual `cantrip_cua/js` calls returned 73 twice across
  calls; `js_reset` succeeded and a subsequent `typeof` returned `undefined`.
  The agent received the covered fixture image with its white `MCP` ring at
  (160,120). Follow agent displayed that same 320 × 240 image with one cursor
  and real root/turn/session/worker attribution. Stop cleared it during the
  active turn. Protected Trajectory exposed both successful operations and
  failures, including the exact initial `console.log` misuse in protected Raw.
  `console` is unavailable; final-expression returns succeeded. No screenshot
  file or second image audit store was created by this walkthrough.
- Measurements on the signed debug helper: 20 fresh-process handshakes median
  26.919 ms / p95 40.422 ms; 30 warm fixture snapshots median 158.510 ms / p95
  169.076 ms (320 × 240, 980-byte PNG). After session close, 29.002 seconds idle
  added 0.00 seconds CPU at `ps`'s 0.01-second resolution; RSS median 35,136 KiB,
  peak 35,280 KiB. These use warm filesystem cache and concurrent dev services,
  include capture/encoding/pipe time, and are not release or startup comparisons.
- Separate in-process protected transport, one warm-up plus 30 samples per size:
  1,129-byte PNG median 1.469 ms / p95 2.848 ms; 2,618,198-byte PNG median
  256.670 ms / p95 262.359 ms, ten chunks and 3,495,740-byte HTTP response.
  Large-image route median 81.552 ms; client decrypt/reassembly 170.609 ms.
  Actual AEAD, server handler and client codec verified exact bytes/digest/raster;
  capture was synthetic and no helper launched. Fixture copying contributes to
  these timings; real network latency and startup impact are not measured here.
- Evidence: native and transport harnesses, raw samples and structured live QA
  are retained outside the checkout under `/tmp/cua-13-evidence`.
- Remaining tranche work: browser live-account walkthrough, independently
  measured human-pointer isolation, remaining live approval/cancellation and
  child-observer coverage, enclosing packaged-app/update permission evidence,
  normal startup comparison, relevant broad regressions and completion audit.
  Better target discovery and managed evaluator guidance remain follow-ups.
  Native input, Accessibility, clipboard/files, other native OS backends and
  the full roadmap below remain deferred.

### Tranche cycle 14 — Preview identity and responsive target selection

- Branch: `codex/cua-14-preview-attribution`, based on cycle 13's observed
  merge `96ac98106`. [PR #1758](https://github.com/ArcaneArts/Cantrip/pull/1758),
  implementation commit `81d7f5a4`, final head
  `1ec4db0379f0a0097a8382d8be9e1c6756bc1756`. All four jobs in CI run
  `33979939094` passed before squash auto-merge. Observed merged 2026-09-05
  at 17:14:45 UTC as `03b71c40216302d8ac6cbbf75f565d036127e31b`; Primary
  was fast-forwarded cleanly. Its clean worktree was retained for live QA
  until cycle 15 moved the frontend forward.
- Implemented: manual preview displays the server-authorized lease's worker
  and the actual native session ID, with an explicit not-started state before
  session creation. Stop removes this attribution with the cleared image.
  Manual target and agent-source selectors occupy a full row on small screens;
  desktop controls retain the existing shared row. No routing or native API
  changes, and no new agent or subagent was started for this pass.
- Focused verification on macOS arm64/Node 24.14.0: app preview/controller,
  cursor, coordinate and client tests pass 162 tests across five files.
  Command: `pnpm --filter @cantrip/app exec vitest run
src/components/computer-use src/lib/computer-use-client.test.ts
src/lib/computer-use-preview-encryption.test.ts`. New rendering cases cover
  the pre-session worker identity and clearing the session during Stop.
  `pnpm --filter @cantrip/app... build` passes. `pnpm check` again stops at
  unchanged server decomposition counts 2,156/2,149 versus 1,999; subsequent
  chained checks did not run. This is not a whole-repository green claim.
- Actual browser acceptance: the isolated account was imported through the
  normal recovery-file UI without reading its contents; the temporary export
  was removed afterward. The cycle 14 frontend at port 1420 reused cycle 13's
  real server/worker and the stable signed native helper. No browser-side
  native execution or fake capture was used. The previous native Tauri
  acceptance remains cycle 13 evidence; this pass exercised the browser UI.
- Live owned fixture `macos-window-45428`, generation 412, was fully covered
  by its distinct occluder. The actual shared preview showed its red center
  and green/yellow/cyan/magenta corners. Desktop: 320 × 240 native/displayed
  image, 1,139-pixel dialog with equal scroll width, 726.6875-pixel selector,
  worker `local-MaxBook-Pro.local` and native session
  `87521f2e-94a4-4171-8ed2-a3b4ea7740dc`. Stop removed the image and identity.
- At a 390 × 844 browser viewport, the dialog's client/scroll widths both
  measured 345 pixels; both manual and agent-source selectors measured 313
  pixels. The native 320 × 240 image displayed at 295 × 221.25, with the new
  session `0eebcc0c-934c-4f7f-8b7b-2f025856b1db` visible. A white size-32
  crosshair labeled `Mobile` appeared once at the image center after explicit
  customization and logical movement. Stop succeeded, the fixture exited,
  and the temporary viewport override was reset. Follow mode's empty source
  state was verified without starting another agent.
- Additional compatibility evidence from cycle 13: 178 app, 71 worker and 87
  server tests passed (336 total), covering editor, terminal, networking,
  authentication/encryption and injected Remote Desktop paths. Three server
  Remote Desktop cases could not run because their fixture violates
  `projects_managed_folder_identity_check`; the same setup failure was
  reproduced in an exact archive of base `420c4f90e`. This is not native
  Remote Desktop walkthrough evidence. Exact commands, logs and baseline
  reproduction are retained in `/tmp/cua-13-compatibility-report.md`.
- Normal worker startup comparison: baseline `cbfa5df6d4f9308947bd485dc8d980caed323829`
  versus merged `96ac98106`, frozen offline builds, identical generated
  version and actual Codex 0.153.1/CLI binaries; one warmup plus five alternating
  measured starts per revision. Real startup-ready medians were 767.6 versus
  746.0 ms; authenticated command-ready medians 780.3 versus 754.2 ms. All 12
  successful starts launched zero CUA helpers and sent zero CUA requests.
  Ranges overlap, so no causal speed improvement is claimed. These were new
  connected workers awaiting encryption grants, using a schema-valid fixture
  server; existing desktop initialization was not suppressed. Post-ready
  CodeGraph installation consumed CPU/memory, so those samples are not idle
  measurements. One initial missing-CLI failure is retained separately.
  Harness, samples and limitations: `/tmp/cua-startup-benchmark.Xh1L16/REPORT.md`.
- Remaining required work: explicit cursor preferences were observed to reset
  after the runtime restart; persistence across sessions/restarts must be
  implemented through existing settings. Human-pointer isolation is still
  unproven: two before/after readings changed while human use was uncontrolled,
  and earlier standalone probes failed inventory before reaching movement.
  Remaining live lifecycle coverage, enclosing packaged-app/update identity
  evidence, final manual procedure and requirement-by-requirement completion
  audit remain open. Full-roadmap deferrals remain unchanged.

### Tranche cycle 15 — Encrypted cursor appearance preferences

- Branch: `codex/cua-15-cursor-preferences`, based on cycle 14's observed
  merge `03b71c402`. [PR #1759](https://github.com/ArcaneArts/Cantrip/pull/1759),
  implementation commit `72ec1c14`, final head
  `4cf0df4d3c75865f037ef4919a1b01577b224984`. All four jobs in replacement CI
  run `33982586919` passed before squash auto-merge. Observed merged at
  `2026-09-05T18:02:23Z` as `991040c7ada9286a281905f049de95419661bd5b`;
  Primary fast-forwarded cleanly. The worktree remains for its packaged artifacts
  and the active QA frontend/server.
- Implemented: explicit Save applied appearance and Forget saved appearance
  controls use the existing account settings route and row. The nullable JSONB
  column contains a bounded authenticated ciphertext record under the existing
  customization-content component. Only the typed appearance is encrypted;
  native target IDs, session IDs, coordinates and observations are excluded.
  Migration `0200_computer_use_cursor_preference` adds no CUA session table.
  Forgetting the saved preference does not change the current session.
- Restoration occurs when a target is explicitly selected in a new manual
  session, before its first snapshot, through the normal authorized cursor
  operation and protected Trajectory path. Later unsaved session changes are
  preserved across target selection. Required cursor approval remains pending
  for an explicit retry; no operation is replayed automatically. Settings reads
  are bounded to 15 seconds, and a failed preference read reports its actual
  inability to restore while still attempting native capture. Stop cancels
  restoration and suppresses late configuration/capture. Save/load are pinned
  to the authenticated account/server lifetime and encryption key revision.
- Regression found and fixed during verification: placing the nullable column
  before the primary key made Drizzle classify an existing left-joined settings
  row as missing, changing inherited CUA policy to its fallback. The merged
  baseline passed the same test; keeping the non-null ID first restores the
  real policy. The current-repository authority fixture now applies all
  migrations, while historical migration-specific fixtures retain their
  deliberate boundaries. All 24 focused authority/model/account cases pass.
- Verification on macOS arm64 with Node 24.14.0 and Rust 1.95.0:
  `pnpm cua:test:worker` passes 1,252 tests against the compiled helper:
  133 protocol, 25 crypto, 571 worker, 225 server, 298 app. The same three
  explicit server skips remain (two dedicated PostgreSQL cases and opt-in
  native fixture). The boundary command now includes cursor preference and
  account API regression cases. Full protocol: 666 tests across 69 files.
  `pnpm --filter @cantrip/app... build` and
  `pnpm --filter @cantrip/server --filter @cantrip/worker build` pass.
  New real-AEAD cases reject changed owner/server/operation/ciphertext/key
  revision, enforce envelope bounds, exclude transient state, and suppress
  late saves on account/key/Stop changes. Actual account HTTP/database cases
  prove CSRF enforcement, owner isolation, persistence, and partial-update
  preservation. `pnpm check` still stops at unchanged server decomposition
  counts 2,156/2,149 versus 1,999, before later chained checks.
- CI follow-up: run `33982230565` passed macOS and PostgreSQL. Linux and
  Windows each timed out only the new account integration case at Vitest's
  default five seconds; their actual PGlite migration initialization alone
  exceeded five seconds. The new case now uses the same bounded 30-second
  timeout as every existing case in `auth-api.test.ts`. All five account cases
  pass locally after this test-only correction; replacement CI passed on all
  three hosts, each with 1,252 boundary tests. PostgreSQL also passed separately.
- Actual browser/native acceptance used the existing isolated QA account,
  cycle 15 frontend/server, cycle 13 worker and stable signed native helper.
  On fully covered fixture `macos-window-45605:396`, a white size-36 ring
  labeled `Saved QA` was explicitly applied and saved. The session was stopped,
  the app reloaded and the development server restarted during the package
  rebuild. After reconnecting normally, selecting new covered fixture
  `macos-window-45626:437` created session
  `9eb38476-f47b-4c56-8dcf-040773a23b4b`; its first real 320 × 240 snapshot
  showed the saved ring/label and the fixture's expected colors. The UI reported
  Saved appearance restored. Forget confirmed removal without changing the
  current ring, then Stop succeeded and both owned fixtures exited. No provider
  credentials, recovery contents or screenshot files were read or stored.
- Follow-up cycle 14 pointer evidence: actual preview moves to center, right,
  down, left and up advanced native snapshots #2 through #7. Six read-only
  `CGEvent(source:nil).location` samples all remained exactly
  `(567.63671875, 411.57421875)` while the visible logical cursor moved.
  No native input, event tap or continuous input monitoring was used. Sampling
  does not exclude transient movement between readings; source inspection of
  `service.rs` CursorMove and `cursor.rs` move_to confirms this path only updates
  logical state, with raster composition separate and no OS pointer API call.
  Earlier inconclusive readings and failed inventory probes remain recorded.
  Raw samples/method: `/tmp/cua-14-pointer-results.json`.
- Cleanup: cycle 14's clean worktree was removed after its baseline comparison
  completed and the live frontend moved to cycle 15. Cycle 12 retains the QA
  profile/native app; cycle 13 retains the running worker and fixture tooling.
- Remaining first-tranche work: finish the live lifecycle and enclosing
  packaged-app/update identity acceptance, reconcile final build/CI evidence,
  provide the final reproducible manual procedure, and perform the complete
  requirement audit. Native input, Accessibility, clipboard/files, human event
  monitoring, other native OS backends and the full roadmap remain deferred.

### Tranche cycle 16 — Acceptance procedure and closing evidence audit

- Branch: `codex/cua-16-acceptance-guide`, based on cycle 15's observed merge
  `991040c7a`. [PR #1760](https://github.com/ArcaneArts/Cantrip/pull/1760),
  documentation commit `08163bf0`. This closing PR is its own authoritative
  merge record. All 24 preceding implementation PRs were checked
  through GitHub and confirmed merged. No subagents were started.
- Added a short [acceptance procedure](../COMPUTER_USE_ACCEPTANCE.md) with exact
  development commands, UI entry, approval/Stop behavior, saved cursor preferences,
  actual managed MCP examples, native fixture commands and platform limitations.
  The runtime reference links it and documents the saved appearance controls.
  The [requirement audit](../CUA_FIRST_TRANCHE_AUDIT.md) separates native product,
  compiled deterministic, packaging and unavailable release evidence.
- Final cycle 15 CI run `33982586919` passes on macOS, Windows and Linux, with
  1,252 compiled-boundary cases per host; PostgreSQL passes separately. The initial
  Linux/Windows account-test timeout remains recorded in cycle 15. Relevant builds
  and the 666-test full protocol suite already passed; this documentation pass
  does not claim a new full source-suite run or whole-repository green.
- Additional live browser acceptance: Workspace inventory requested an ordinary
  approval before listing native targets. While it remained outstanding, Stop
  immediately returned Preview stopped, disabled capture controls, removed the
  approval controls and recorded a completed protected Preview operator Stop.
  The QA chat's prior YOLO setting was restored; account defaults were untouched.
  Evidence: `/tmp/cua-15-live-stop-evidence.md`. Compiled tests separately cover
  Stop/reset during busy JavaScript, late replies and root/child isolation.
- Actual macOS desktop packaging ran in the retained cycle 15 worktree using
  `pnpm package:app --target darwin-arm64`, Node 24.14.0, Rust 1.95.0,
  `CANTRIP_REQUIRE_MACOS_SIGNING=1` and the available Developer ID certificate.
  Bundled Codex 0.153.4, worker/runtime and the optimized Tauri application built;
  nested runtime signing preceded enclosing app signing. The chain emitted
  Cantrip 1.1.1810 `.app`, DMG and updater archive, then exited 1 because
  `TAURI_SIGNING_PRIVATE_KEY` was absent. Tauri also explicitly skipped
  notarization for absent Apple credentials. This is not a green package run.
- Verification of the actually emitted artifacts succeeded with the existing
  `scripts/verify-macos-distribution.mjs`: one certificate-signed app, one signed
  DMG and 28 embedded runtime binaries, including real helper protocol/fake
  snapshot and packaged Sharp checks. The exact helper inside the signed app
  passed all six native decoded-fixture scenarios: foreground, partial/full
  occlusion, movement, resize and recreation, plus retired-target rejection and
  session shutdown. Native snapshots were 320 × 240 then 384 × 288; individual
  capture samples 123–264 ms are smoke timings, not a performance comparison.
- Artifact paths are under
  `/private/tmp/cantrip-cua-15/cantrip_app/src-tauri/target/release/bundle/`.
  Helper SHA-256:
  `92c9250dcef146a726293cf7e96e8ca74a019edf509bfcbce70806caec746d1d`;
  DMG SHA-256:
  `05e7265665a60010e1e592aab1b1991c07326f3a2cb9074e68fa63ba0d91e583`;
  updater archive SHA-256:
  `452a61989abe2e3e2058d4d33694a973bffff60ac985472442a2c82aab700026`.
  Helper identity is `art.cantrip.cua`, Developer ID Application: Arcane Arts
  Inc. (RK2CYG6XRV), hardened runtime with secure timestamp. No synthetic/ad-hoc
  fallback or release upload occurred. Logs: `/tmp/cua-15-package-app.log`,
  `/tmp/cua-15-distribution-verify.log`, `/tmp/cua-15-packaged-native.log`.
- Changed-development-build check: the existing debug helper SHA-256
  `9567fa9b78e180bc885943c7caf70d3e79c62594802049cb6d93053e3130ed01`
  was replaced by the ordinary `cua:install:dev --release` command with
  `CANTRIP_DEV_PROFILE=cua-cycle-three-qa`. New SHA-256:
  `e4179599ae5a9646579f36ff6c3527a3e8b37642d4dde72cc1a8c1828f8f6381`.
  The native user-data path and Apple Development designated requirement remained
  identical. Direct smoke launches returned `capture-failed` both before and after
  replacement; this does not prove a signing or permission cause.
- After restarting only the owned QA services to load the replacement, the actual
  browser -> server -> worker -> stable helper path captured fully covered fixture
  `macos-window-45705:397` in native session
  `80db3b46-d280-4ddb-abcb-497055b0afc3`. Snapshot #1 was 320 × 240 with the expected
  red center and green/yellow/cyan/magenta corners, visually inspected in the UI.
  Stop and fixture cleanup completed. No privacy reset or permission action was
  performed by the agent. Prior debug product captures plus this changed release
  product capture establish this observed update path, not universal TCC continuity
  for all parent processes or installed application updates.
- Release qualification/manual step: supply the real updater private key and
  normal Apple notarization credentials in the private release environment, rerun
  the existing packaging/notarization workflow, then verify a real installed update
  and record capture prompts/results. The goal permits explicit documentation when
  signing credentials are unavailable. Neither notarization nor installed-update
  authorization is inferred from successful native helper capture.
- Cleanup/retention: all owned fixture windows and preview sessions are closed.
  Cycle 12 retains the isolated configured QA profile/native app, cycle 13 the
  worker/tooling, and cycle 15 the QA frontend/server and actual signed artifacts.
  The installed Cantrip application and unrelated worktrees remain untouched.
  Closing documentation delivery/merge observation is the remaining repository
  action. Native input, Accessibility, clipboard/files, human event monitoring,
  continuous video, other native platforms and cross-worker control remain deferred.

This document proposes a first-party computer-use subsystem named
`cantrip_cua`. It is a future implementation plan, not a description of
currently available product behavior.

The intended user experience is:

1. Start an agent on a macOS worker.
2. Give that agent a task that requires seeing or operating applications on
   the same worker.
3. Let the agent select a monitor, application, or individual window and
   inspect it even when that window is behind another window.
4. Let the agent use its own visible logical cursor, accessibility actions,
   pointer and keyboard input, clipboard operations, application controls,
   and structured Finder/file operations.
5. Continue using the computer while the agent works. The agent observes
   relevant human input events and adapts instead of automatically pausing.
6. Watch the session from Cantrip on desktop, web, iPhone, or Android, with
   trajectory history showing what the agent saw and did.

Computer use runs only on the worker hosting the agent. A client may prompt,
observe, approve, or stop that agent from another device, but the agent does
not control the client device. Worker-to-worker desktop control is a possible
future capability and is not part of the first release.

The first release targets macOS only. Windows and Linux are future backends.

## Goals

- Add a top-level first-party Rust package named `cantrip_cua`.
- Make the worker that runs an agent the sole machine on which that agent may
  execute computer-use operations.
- Capture a selected monitor or individual application window without
  requiring the window to be unobscured or foregrounded when macOS APIs allow
  direct window capture.
- Give the agent a distinct logical cursor that is visible in observations
  and monitoring UI without treating the human pointer as the agent's durable
  state.
- Let agents and humans collaborate without automatically pausing the agent on
  every human input event.
- Report human pointer, keyboard, focus, window, and scene-change events to the
  agent when they are relevant to its active target.
- Integrate authorization with Cantrip's existing effective permission
  profile and durable agent-interaction system. Selected YOLO mode must not
  add a separate computer-use confirmation.
- Expose a provider-neutral managed MCP interface, including a persistent
  JavaScript execution surface optimized for models that can efficiently
  compose computer actions.
- Record computer-use actions, including ordinary typed text, in the existing
  protected Trajectory path with appropriate secret-field redaction.
- Allow desktop, web, iPhone, and Android Cantrip clients to observe the
  worker-local session.
- Ship `cantrip-cua` with the worker distribution in the same general manner as
  the bundled Codex and Cantrip CLI runtimes.
- Keep normal worker startup fast by loading the computer-use runtime lazily.
- Produce real native errors when capture or input fails rather than blocking
  valid operations with cached or secondary preflight guesses.

## Non-goals for the first release

- Controlling the desktop, browser, iPhone, or Android device running a
  Cantrip client.
- Letting an agent running on one worker control a different worker.
- Reusing the current Remote Desktop adapter, session model, capture pipeline,
  or persisted Remote Desktop tab as the computer-use runtime.
- Windows, Linux, X11, Wayland, iOS UI automation, or Android UI automation.
- Headless display creation or virtual-machine orchestration.
- Bypassing macOS login-window, lock-screen, privacy, sandbox, or other
  operating-system security boundaries.
- A permanent application blocklist maintained separately from Cantrip's
  permission system.
- Per-click confirmations when the effective permission profile already
  authorizes the operation.
- A general-purpose JavaScript, shell, filesystem, or network sandbox exposed
  to the model.
- Retaining full screenshots or accessibility trees in a second audit
  database.

## Fixed product decisions

The following decisions are part of the initial contract.

### Worker-local execution

The agent and `cantrip-cua` execute on the same worker. The app and server do
not perform native input on the agent's behalf. The server continues to own
durable state and routing, while the worker owns native desktop observation
and side effects.

The initial implementation must reject a target that belongs to another
worker. Future worker-to-worker control requires an explicit protocol and
authorization design rather than silently widening this scope.

### macOS-first delivery

The first complete backend is macOS. It must be designed as a platform-neutral
core with an explicit backend trait, but incomplete Windows or Linux adapters
must not delay the first release or create misleading capability claims.

### First-party implementation

`cantrip_cua` is a purpose-built Cantrip package. It may use maintained crates
that expose narrow operating-system bindings, image codecs, serialization, or
an isolated JavaScript engine. It must not embed a broad computer-use product
whose unrelated tools, authorization rules, logging, or protocol become part
of Cantrip by accident.

The current `@zavora-ai/computer-use-mcp` dependency may be studied for
behavioral characterization and parity tests. It is not the target runtime.
The implementation should prefer direct macOS frameworks through focused Rust
bindings over forking the whole dependency.

### Existing permission system remains authoritative

Computer use does not invent another global permission-mode selector. The
chat's selected and effective Cantrip permission profile remains authoritative.
When the effective profile requires an approval, the request uses the existing
durable agent-interaction path. When selected YOLO mode resolves to Codex's
`never` approval policy, computer use proceeds without an extra Cantrip prompt.

The Rust process receives capability-scoped authorization from the worker. It
does not independently decide whether the user should be prompted.

### Collaborative input

Human activity does not automatically pause the agent. The system distinguishes
agent-generated events from human-generated events, publishes relevant human
activity into the computer-use session, and lets the agent respond to the new
scene.

The UI still provides explicit Stop and Disable Computer Use actions. A user
may stop a session immediately without waiting for the current model turn to
finish.

### Independent CUA observation path

Computer use is not implemented as an extension of
`ManagedDesktopRemoteSurfaceAdapter`. It has a dedicated target model, capture
session, input scheduler, observation stream, and client monitor.

The implementation may reuse low-level authenticated WorkerLink routing,
encrypted binary framing, common viewport helpers, or generic image components
where their semantics fit. It must not inherit Remote Desktop's foreground
window assumptions, human-input ownership, persisted surface lifecycle, or
capture fallback behavior.

## Architectural decision

`cantrip_cua` is a worker-owned Rust sidecar with a versioned private protocol.
The worker remains the authorization and orchestration boundary. A managed MCP
host gives Codex a provider-neutral computer-use interface, and a dedicated
CUA observation channel lets Cantrip clients monitor the same worker-local
session.

```text
Cantrip client on desktop, web, iPhone, or Android
  - prompts and approvals
  - live CUA monitor
  - user/agent cursor presentation
  - Stop / Disable Computer Use
                |
                | existing authenticated app/server/worker routing
                v
Cantrip worker running the agent
  - effective permission profile
  - durable approval bridge
  - task/turn ownership
  - CantripCuaService
  - trajectory publication
                |
                | private framed child-process protocol
                v
cantrip-cua Rust sidecar
  - native target inventory
  - window and monitor capture
  - logical agent cursor
  - human-input observation
  - accessibility snapshot/actions
  - pointer/keyboard/clipboard input
  - applications and Finder/file operations
  - bounded persistent JavaScript sessions
                |
                v
macOS frameworks
  - ScreenCaptureKit
  - Accessibility
  - CoreGraphics
  - AppKit / Foundation
```

There is no app-to-sidecar connection and no sidecar network listener. All
access is mediated by the worker hosting the agent.

## Relationship to existing Cantrip systems

Cantrip already has useful seams that should be extended selectively:

- Permission profiles live in
  [`packages/protocol/src/permission-profiles.ts`](../../packages/protocol/src/permission-profiles.ts).
- Durable command, file, permission, user-input, and MCP approval behavior is
  documented in
  [`docs/AGENT_INTERACTIONS.md`](../AGENT_INTERACTIONS.md).
- Worker-managed MCP configuration is assembled in
  [`cantrip_worker/src/mcp/managed.ts`](../../cantrip_worker/src/mcp/managed.ts).
- Protected raw tool capture is produced in
  [`cantrip_worker/src/codex/raw-capture.ts`](../../cantrip_worker/src/codex/raw-capture.ts).
- Trajectory's protected diagnostic contract is documented in
  [`docs/TRAJECTORY.md`](../TRAJECTORY.md).
- The current native input wrapper is in
  [`cantrip_worker/src/desktop/automation-client.ts`](../../cantrip_worker/src/desktop/automation-client.ts).
- The current Remote Desktop capture implementation is in
  [`cantrip_worker/src/desktop/desktop-frame-source.ts`](../../cantrip_worker/src/desktop/desktop-frame-source.ts).
- Worker packaging and the desktop's bundled worker runtime are assembled in
  [`scripts/package-distributions.mjs`](../../scripts/package-distributions.mjs).

Existing Remote Desktop behavior is a characterization source, not the CUA
architecture. CUA-specific protocol types should live in their own protocol
module rather than extending `remote-desktops.ts` with a second meaning for
the same records.

## Rust package layout

The repository currently keeps Rust packages independent rather than using a
root Cargo workspace. `cantrip_cua` should initially follow the same shape as
`cantrip_cli`.

```text
cantrip_cua/
  Cargo.toml
  Cargo.lock
  README.md
  src/
    lib.rs
    main.rs
    protocol.rs
    service.rs
    session.rs
    target.rs
    observation.rs
    capture.rs
    input.rs
    cursor.rs
    accessibility.rs
    applications.rs
    filesystem.rs
    permissions.rs
    javascript.rs
    platform/
      mod.rs
      macos.rs
  tests/
    fixtures/
    protocol.rs
    session.rs
```

Naming conventions:

- Repository directory: `cantrip_cua`
- Cargo package: `cantrip-cua`
- Library crate: `cantrip_cua`
- Executable: `cantrip-cua` on macOS and `cantrip-cua.exe` on a future Windows
  backend

The library owns native and session behavior. The executable owns process
transport, structured stderr logging, graceful shutdown, and crash containment.

## Worker service ownership

Add one `CantripCuaService` to the worker process. It is the single owner of:

- Lazy sidecar discovery and launch.
- Sidecar version and capability negotiation.
- Task, thread, turn, and worker authorization bindings.
- CUA session creation and teardown.
- Managed MCP calls.
- Client observation attachments.
- Existing permission-profile decisions and approval requests.
- Trajectory event publication.
- Sidecar crash recovery and session failure reporting.

The service starts the sidecar on the first authorized computer-use request.
It does not add native initialization to ordinary worker startup. Once started,
the sidecar remains available for the worker lifetime unless it crashes or is
explicitly disabled.

The worker may restart an unexpectedly terminated sidecar once and report the
actual failure. It must not retry indefinitely or hide a repeated crash behind
a permanent loading state.

## Private worker-to-sidecar protocol

Use a versioned, length-prefixed protocol over child-process stdin and stdout.
Do not expose a TCP listener, HTTP endpoint, Unix socket, or named pipe in the
initial implementation.

The protocol contains:

- A JSON or compact structured header validated on both sides.
- Optional binary payload bytes for screenshots and thumbnails.
- Request, response, event, and cancellation frames.
- Monotonic request and event sequence numbers.
- Explicit protocol version and capability negotiation.
- Bounded message, image, accessibility-tree, and text sizes.
- Session and target-generation identifiers on state-sensitive operations.
- Structured, redacted diagnostics on stderr only.

Do not base a decision to run an operation on a stale cached permission status
or a secondary health guess. Attempt the authorized native operation and
return its real result. Target generations are used only when the target is
known to have changed or disappeared.

Initial operations should include:

- `capabilities.get`
- `targets.list`
- `target.attach`
- `target.detach`
- `observation.snapshot`
- `observation.subscribe`
- `input.batch`
- `window.activate`
- `window.restore`
- `accessibility.snapshot`
- `accessibility.query`
- `accessibility.action`
- `application.list`
- `application.launch`
- `clipboard.read`
- `clipboard.write`
- `filesystem.open`
- `filesystem.reveal`
- `filesystem.copy`
- `filesystem.move`
- `filesystem.rename`
- `filesystem.trash`
- `javascript.evaluate`
- `javascript.reset`
- `session.close`

Action batching lets the model compose several low-latency inputs without a
separate MCP round trip for every mouse movement or keystroke. The sidecar
returns a fresh observation after a batch when requested.

## Target model and capture semantics

CUA targets are transient worker-local native objects, not durable Remote
Desktop records. A target can be:

- A monitor.
- A native window.
- An application, resolved to one or more windows.

Every target includes:

- Opaque native target ID.
- Target kind.
- Application and process identity when available.
- Window title when available.
- Logical bounds in the global desktop coordinate space.
- Pixel dimensions.
- Scale factor.
- Occlusion, minimized, hidden, and focused state when knowable.
- A target generation that changes when the native object is replaced.

Coordinates exposed to the model use target-local logical points. The Rust
backend owns conversion to native global points, pixels, scale factors, and
negative monitor origins.

### Individual-window capture

The macOS backend should use ScreenCaptureKit window capture so an attached
window remains visible to the agent when another window covers it. The
implementation must characterize and report the actual behavior for:

- Background and unfocused windows.
- Partially or fully occluded windows.
- Windows on another Space.
- Hidden applications.
- Minimized windows.
- Windows that move, resize, close, or are recreated.

Where macOS does not produce frames for a particular state, CUA reports that
state precisely. It must not silently replace a selected window with the full
monitor or focus the window merely to make capture appear successful.

The macOS login window and lock screen are protected operating-system surfaces.
CUA must not claim it can bypass those boundaries. This is distinct from
capturing a normal background or occluded application window.

### Monitor capture

Monitor mode supports every display reported by macOS, including mixed scale
factors, Retina displays, rotated displays, and negative global coordinates.
The primary display is a property, not an implicit default after the user or
agent selects another display.

## Agent cursor and human collaboration

macOS exposes one real system pointer. Cantrip therefore represents the agent
cursor as explicit CUA session state rather than pretending the operating
system provides two independent native pointers.

The agent cursor contains:

- Target-local logical coordinates.
- Cursor shape or action state when known.
- Last agent movement and action time.
- Visibility and color identity for observation rendering.
- The task and session that own it.

Snapshots returned to the model and frames shown in the CUA monitor render the
agent cursor as an overlay. Human pointer presentation remains distinct.

For an accessibility-addressable control, prefer a targeted Accessibility
action that does not require moving the human pointer or foregrounding the
window. Coordinate-based CoreGraphics input may still use the shared native
pointer and focus rules. The protocol and trajectory must identify which
method was used instead of implying that arbitrary coordinate clicks are
physically independent.

The macOS backend should mark generated CoreGraphics events with a private
source tag and observe native input with an event tap. This allows the session
to distinguish agent-generated events from human-generated events.

Relevant human events are published into the session, including:

- Pointer movement, click, drag, and scroll within the active target.
- Keyboard and modifier activity routed to the active target.
- Target focus, movement, resize, visibility, and content changes.
- Clipboard changes initiated through Cantrip when observable.

Human input increments the scene revision and becomes part of the agent's next
observation. It does not automatically pause or cancel the agent. If human and
agent actions overlap, the input scheduler preserves the real event ordering
and the resulting scene is authoritative.

Secure text fields require special handling. Human or agent text directed at a
field identified by Accessibility as password or secure input is represented
as a redacted input event with length metadata rather than plaintext.

## macOS native backend

The first backend should use focused Rust bindings to native macOS frameworks:

- ScreenCaptureKit for direct display and window frames.
- Accessibility APIs for window inventory, semantic snapshots, focus,
  control actions, and secure-field detection.
- CoreGraphics for coordinate pointer, scroll, and keyboard events where a
  semantic action is unavailable.
- AppKit and Foundation for application activation, clipboard, icons, paths,
  and Finder integration.
- ImageIO, Accelerate, Metal, or a focused image codec only where measurement
  shows that conversion or encoding needs it.

Native handles stay inside the Rust process. The worker sees validated opaque
IDs and bounded serializable results.

### Permissions and stable identity

Screen Recording and Accessibility permission belong to a stable shipped
runtime identity. `cantrip-cua` is bundled with the worker alongside the Codex
and Cantrip CLI runtimes, signed as part of the desktop distribution, and
resolved from a stable installed location.

Development must also use a deliberate stable helper identity and location.
Rebuilding a worktree must not produce a new permission identity or cause
repeated macOS prompts. The initial macOS spike must prove the development and
release signing behavior before broader implementation proceeds.

Permission status is diagnostic information. The actual capture or input call
remains authoritative. A denial returns a precise recovery state and opens the
normal macOS/Cantrip guidance; it must not cause an infinite retry or a generic
loading screen.

## Accessibility model

Accessibility is a first-class observation and action path rather than a
post-hoc optimization.

An accessibility snapshot should contain a bounded target-local tree with:

- Stable-within-generation element IDs.
- Role, subrole, label, value, description, and state.
- Target-local bounds.
- Focus, enabled, selected, expanded, editable, and secure flags.
- Supported semantic actions.
- Parent/child relationships.

The tool can query by element ID or bounded predicates and perform only actions
the snapshot advertised. Element IDs are invalidated when the target generation
changes or the native element is no longer present.

Accessibility actions are preferred for buttons, fields, menus, lists, tabs,
and other semantic controls. Screenshots and coordinate input remain available
for canvases, games, custom renderers, and other interfaces without adequate
accessibility metadata.

## Applications, Finder, and file operations

Routine filesystem work should use structured worker-owned operations rather
than pixel navigation through Finder:

- Open a file or directory.
- Reveal a path in Finder.
- Copy, move, rename, or trash an exact path.
- Launch or activate an application.
- Open a path with a selected or default application.

These operations remain constrained by the task's effective permission profile
and worker filesystem authority. They use the existing approval path when an
approval is required.

Finder remains available as a visual CUA target when manipulating Finder itself
is the requested task. Structured operations and visual operations share
trajectory attribution but are not disguised as one another.

## Managed MCP and model interface

Add a worker-managed MCP server named `cantrip_cua`. It is injected only when:

- The current worker reports a compatible CUA runtime.
- The current agent context supports computer use.
- The current task is bound to that worker.

The MCP host connects to `CantripCuaService` through the existing
capability-scoped worker broker. It never launches or connects to the Rust
sidecar directly.

The initial model-facing tools are:

- `js`
- `js_reset`
- `snapshot`, if measurements show that a small direct first-observation tool
  materially improves discovery or failure handling

The persistent `js` environment exposes a documented `cua` object. A typical
flow should be possible in one call:

```javascript
const state = await cua.getState();
const target = await cua.getWindow(state.windows[0].id);
await target.activate();
await target.click(420, 180);
await target.type("hello");
await target.key("ENTER");
await target.snapshot();
```

The same service exposes structured action primitives internally for provider
portability, deterministic tests, and future models that do not use a code
execution interface.

### JavaScript isolation

The persistent evaluator should run in the Rust sidecar using a maintained,
embeddable JavaScript engine selected during the initial spike. The exposed
environment contains only the `cua` API and safe language built-ins.

It must not expose:

- Native process or environment access.
- Arbitrary filesystem access.
- Network access.
- Dynamic native-library loading.
- Unbounded timers, workers, memory, output, or execution time.

Each evaluator is scoped to one authorized CUA session. It has bounded memory,
script size, execution duration, action count, screenshot count, and output.
`js_reset`, turn interruption, task stop, permission revocation, worker
disconnect, and session teardown all cancel pending work and dispose the
context.

## Permission and approval behavior

The effective permission profile selected through Cantrip is the source of
truth. Define CUA operation classes in the worker policy projection, such as:

- Observe screen or accessibility state.
- Use pointer and keyboard input.
- Read or write the clipboard.
- Launch or focus applications.
- Perform structured filesystem mutations.

The profile-to-operation mapping belongs in Cantrip's existing policy and
permission integration, not in platform-specific Rust code. Any required
approval becomes an ordinary durable agent interaction with task, thread,
turn, item, worker, target, and operation provenance.

Selected YOLO mode does not receive a second CUA prompt. Other profiles may
require an approval according to their effective policy. There is no separate
application denylist and no unconditional ban on Cantrip, terminals, password
managers, system settings, or security applications. The user-selected policy
and operating-system permissions remain authoritative.

The client always retains an out-of-band Stop/Disable control. This is a
lifecycle control, not an approval prompt.

## CUA observation and client monitoring

Create a dedicated CUA observation protocol rather than persisting a Remote
Desktop surface. The live channel carries:

- Current target metadata and generation.
- Encoded target frames.
- Agent cursor overlay state.
- Human pointer and input-event summaries.
- Capture, input, and permission status.
- Task, turn, and session attribution.
- Current agent action and outcome.

The server routes the stream to authorized clients but does not decode or
persist frame content. Desktop, browser, iPhone, and Android clients can attach
as observers. Client input to the worker's desktop remains a distinct future
decision; the first CUA monitor is primarily for observation, approval, and
Stop/Disable controls.

The monitor should be reachable from the active task and Trajectory. It should
show which worker, application/window or monitor, task, and agent own the
session. Multiple clients may observe the same session without creating
multiple capture sessions.

## Trajectory and audit behavior

CUA actions are ordinary protected agent activities and extend the existing
Trajectory model instead of creating a separate audit database.

Each activity records:

- Task, agent, thread, turn, and item correlation.
- Worker and CUA session identity.
- Target identity and generation.
- Action kind and execution method, such as Accessibility or CoreGraphics.
- Target-local coordinates and agent cursor state when applicable.
- Ordinary typed text.
- Key combinations and clipboard operation metadata.
- Timing, duration, status, and bounded native error information.
- Scene revision before and after the action.
- Whether intervening human input was observed.

Typed text is captured inside the existing encrypted protected-raw envelope,
not plaintext logs or server metadata. Known credentials continue through the
existing redaction path. Text sent to an Accessibility-secure field, text
explicitly marked sensitive by the calling tool, and values recognized as
credentials are stored as redacted metadata rather than plaintext.

Screenshots and full accessibility trees are not copied into a second audit
store. When a bounded screenshot is already part of the model-visible tool
result, existing encrypted message and attachment behavior remains
authoritative. Trajectory may retain a digest, dimensions, target generation,
and omission/truncation metadata.

Human collaboration events appear in the same turn trajectory so a reviewer
can understand why the scene changed between agent actions. Raw native event
streams are coalesced into meaningful bounded events rather than persisting
every mouse-move sample.

## Persistence

CUA sessions and native target IDs are transient worker state. They do not
require durable server database tables in the first release.

Durable information remains in existing systems:

- Selected and effective permission profile in chat state.
- Approvals in durable agent interactions.
- Actions and results in encrypted chat/trajectory content.
- Worker capability observations in the existing worker capability path.

If a future feature needs persistent CUA preferences, store only explicit user
preferences such as monitor or application selection. Never persist a native
window handle as a durable identity.

## Development and packaging

Add root scripts consistent with `cantrip_cli`:

- `cua:build`
- `cua:build:release`
- `cua:test`
- `cua:check`

Add a focused build helper under `scripts/cantrip-cua/` that:

- Builds the standalone Cargo manifest with `--locked`.
- Resolves debug and release artifacts without relying on a worktree-specific
  target path as durable runtime identity.
- Bundles `cantrip-cua` into the worker's `bin` directory.
- Makes the executable bit explicit on macOS.
- Verifies the packaged runtime by launching it and completing the real
  version/capability handshake.

The worker runtime resolver should check an explicit development override and
the known packaged binary location. It should invoke the selected binary and
let launch or handshake fail with the real error rather than rejecting it
based only on a version file or filesystem heuristic.

The desktop runtime already bundles the packaged worker. No separate
app-to-sidecar path or Tauri command should be introduced.

### macOS signing and updates

The release pipeline must sign `cantrip-cua` before signing the enclosing
runtime and application. Verification must assert the nested executable's
signature and launch the packaged handshake from the final application layout.

Update tests must prove that replacing Cantrip in place preserves the stable
CUA permission identity. Development tests must prove that branch changes and
worktree rebuilds do not create a new permission identity or helper path.

## Testing strategy

### Pure Rust tests

- Protocol framing, bounds, cancellation, and version negotiation.
- Session and target-generation state machines.
- Action batching and output ordering.
- Logical-to-native coordinate conversion.
- Agent cursor and scene revisions.
- Human-versus-agent event classification.
- JavaScript isolation, limits, persistence, reset, and cancellation.
- Secret-field and typed-text audit handling.
- Fake-backend capture, accessibility, input, and failure behavior.

### Worker tests

- Sidecar lazy start and one-time crash recovery.
- Task and worker ownership enforcement.
- Effective permission-profile projection.
- YOLO execution without a duplicate prompt.
- Durable approval routing for profiles that require it.
- MCP task/session binding and stale-call rejection.
- Observation fan-out to multiple clients.
- Protected trajectory capture and redaction.
- No computer-use initialization during an ordinary worker startup.

### macOS integration harness

Build a deterministic fixture application with standard controls, custom
drawn content, a secure field, multiple windows, and observable state. Exercise:

- Monitor and individual-window inventory.
- Direct capture of a fully occluded window.
- Window movement, resize, focus, hide, minimize, close, and recreation.
- Retina scaling and multiple displays with negative origins.
- Accessibility click, value set, selection, scroll, and focus.
- Coordinate click, drag, scroll, key combinations, and Unicode text.
- Distinct agent cursor rendering.
- Human input arriving between and during agent action batches.
- Permission denial and revocation.
- Sleep, lock, unlock, and session recovery as allowed by macOS.
- Packaged and development signing identities.

Tests must describe actual macOS restrictions instead of treating unsupported
secure surfaces as implementation regressions.

### End-to-end acceptance

1. Start an agent on a macOS worker.
2. Select an application window that is behind another window.
3. Capture and understand its current state without bringing it forward.
4. Use an Accessibility action without moving the human pointer.
5. Use coordinate input where the application has no semantic control.
6. Show the agent cursor distinctly in the observation and client monitor.
7. Let the user interact while the agent continues and confirm the agent sees
   the resulting user event and new scene.
8. Run under a profile that requires approval and resolve it through the
   existing interaction UI.
9. Run under selected YOLO mode without a second CUA-specific prompt.
10. Observe the session from a browser or mobile client.
11. Inspect the completed actions and typed text in protected Trajectory data.
12. Stop the session from the client and verify native input ends immediately.

## Performance requirements

Establish baselines before replacing the current native dependencies. Measure:

- Lazy sidecar cold start and handshake.
- Warm target inventory.
- Monitor and window snapshot latency.
- Action-to-observed-frame latency.
- Accessibility query and action latency.
- Image conversion, encoding, and IPC copy cost.
- Idle CPU and memory with and without observers.
- CUA monitor fan-out cost.

Do not set permanent thresholds before the macOS spike measures representative
hardware. After measurement, add release-regression budgets for cold start,
warm observation, input-to-frame latency, idle CPU, and memory.

The normal worker startup path must not eagerly launch the sidecar, request
Screen Recording permission, enumerate displays, or initialize a JavaScript
engine.

## Implementation cycles

Each cycle is an independently reviewable worktree PR and must auto-merge
before the next dependent cycle begins.

### Cycle 1 — Contracts and macOS feasibility

- Add the architecture record and protocol vocabulary.
- Characterize current dependency behavior and parity requirements.
- Prototype stable development/release helper identity.
- Prove ScreenCaptureKit capture of an occluded window.
- Prove agent/human event tagging and Accessibility actions.
- Select focused Rust bindings and the isolated JavaScript engine using
  measured prototypes.

### Cycle 2 — Rust package and fake backend

- Create `cantrip_cua` with locked dependencies.
- Implement protocol framing, capability negotiation, cancellation, session
  ownership, target generations, and fake backend.
- Add Rust build, test, check, and packaging helpers.

### Cycle 3 — Worker service and packaging

- Implement lazy `CantripCuaService` and the sidecar client.
- Bundle the executable with standalone and desktop workers.
- Add real packaged handshake verification and macOS signing coverage.
- Keep product behavior disabled behind capability negotiation.

### Cycle 4 — macOS inventory and capture

- Implement monitor, application, and window inventory.
- Implement direct monitor/window capture, scale conversion, binary image
  transport, and target lifecycle events.
- Add the macOS fixture harness for background and occluded windows.

### Cycle 5 — macOS input, cursor, and collaboration

- Implement the logical agent cursor.
- Implement Accessibility-first actions and CoreGraphics fallback input.
- Tag generated events and observe relevant human events.
- Implement clipboard behavior and scene revisions.

### Cycle 6 — Applications, Finder, and filesystem operations

- Implement application launch, activation, and inspection.
- Implement open, reveal, copy, move, rename, and trash operations.
- Route authorization through the effective permission profile.

### Cycle 7 — Managed MCP and JavaScript execution

- Add the `cantrip_cua` managed MCP.
- Implement bounded persistent `js` and `js_reset` sessions.
- Add provider-neutral structured action support beneath the MCP adapter.
- Return model-visible image observations and precise native failures.

### Cycle 8 — Permission and durable interaction integration

- Define CUA operation classes in the existing permission projection.
- Route required approvals through durable agent interactions.
- Verify selected YOLO mode adds no second prompt.
- Add client Stop/Disable behavior independent from approval state.

### Cycle 9 — CUA monitoring UI

- Add the dedicated observation channel.
- Add desktop, browser, iPhone, and Android monitoring views.
- Render agent and human cursors distinctly.
- Expose active target, worker, agent, action, and Stop/Disable controls.

### Cycle 10 — Trajectory integration

- Add CUA action and human collaboration event kinds.
- Record ordinary typed text in protected raw capture.
- Redact secure-field and credential values.
- Add CUA filters, previews, raw details, timing, and scene correlation.

### Cycle 11 — Legacy native dependency retirement

- Run parity coverage against the macOS release candidate.
- Remove `@zavora-ai/computer-use-mcp` from CUA paths.
- Remove `node-screenshots` only after confirming no remaining product owner.
- Remove duplicated compatibility adapters rather than retaining two native
  execution stacks indefinitely.

### Cycle 12 — Release hardening

- Run the full macOS integration and packaged-app matrix.
- Verify signing, update compatibility, stable permissions, crash recovery,
  and development rebuild behavior.
- Measure and enforce agreed performance budgets.
- Update user, security, developer, release, and troubleshooting documentation.

Windows planning begins only after the macOS completion criteria are met.

## Risks and mitigations

### macOS privacy identity churn

An unstable helper path or signing requirement could repeatedly invalidate
Screen Recording or Accessibility permission. Prove stable development and
release identity in Cycle 1 and treat it as a release compatibility contract.

### Separate cursor expectations

macOS has one real pointer. Maintain an independent logical agent cursor,
prefer Accessibility actions, and label coordinate injection accurately. Do
not promise physical pointer isolation the operating system cannot provide.

### Background-window differences

ScreenCaptureKit behavior varies across minimized, hidden, other-Space, and
protected windows. Characterize each state and report it precisely; never
substitute monitor capture without disclosure.

### Sensitive trajectory text

Typed text can contain credentials. Keep it in encrypted protected raw capture,
redact secure fields and known secret forms, bound its size, and keep it out of
logs, analytics, public metadata, and server-side search.

### Human and agent contention

Concurrent input can change the scene between observation and action. Preserve
real ordering, publish user events, increment scene revisions, and let the
agent re-observe. Do not add speculative preflight checks that prevent a valid
native action.

### Broad native surface area

Keep Rust dependencies narrow and platform modules explicit. Every new native
capability must have an owned protocol operation, permission class, failure
contract, and integration test.

## Completion criteria

The macOS computer-use goal is complete only when:

- `cantrip_cua` exists as a first-party Rust package and bundled worker
  executable.
- Computer use runs on the same worker as the agent and cannot target another
  worker.
- Normal worker startup does not launch or initialize CUA.
- A selected monitor or individual macOS window can be observed directly.
- A normal occluded/background window can be captured without foregrounding
  it when ScreenCaptureKit supports that state.
- Accessibility-first actions and coordinate fallback input both work.
- The agent has a distinct logical cursor visible to the model and monitoring
  clients.
- Human input does not automatically pause the agent and appears as bounded
  collaborative session events.
- Existing permission profiles and durable approvals authorize CUA operations.
- Selected YOLO mode does not receive a duplicate CUA confirmation.
- The managed MCP provides bounded persistent JavaScript execution and a
  provider-neutral structured action layer.
- Desktop, web, iPhone, and Android clients can monitor the worker-local
  session without becoming automation targets.
- Ordinary typed text is visible in encrypted Trajectory details, while secure
  and credential values are redacted.
- The packaged sidecar has a stable signed macOS identity across updates and a
  stable deliberate development identity across worktrees and rebuilds.
- Actual packaged binaries complete a version/capability handshake in CI.
- The existing Remote Desktop implementation continues to work independently.
- Legacy native CUA dependencies are removed after verified parity.
- Focused Rust, worker, protocol, app, packaging, signing, update, and macOS
  integration tests pass.
- User, developer, security, release, and troubleshooting documentation
  describe the implemented behavior and real macOS limitations.

The work must not stop at a protocol scaffold, screenshot-only prototype,
foreground-only automation path, or tool that cannot be monitored and audited
through Cantrip.
