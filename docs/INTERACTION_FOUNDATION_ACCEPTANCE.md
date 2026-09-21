# Interaction foundation acceptance

The extraction and CUA migration are implemented. Remote desktop and embedded-
browser integration remain separate future projects.

On 2026-09-21 the user confirmed background playback, smooth cursor animation,
typing, and concurrent human keyboard/mouse input including app switching without
interruptions. They subsequently directed that further live QA be deferred and
that the pointer-echo fix be treated as provisionally resolved for implementation
completion. The checklist below is deferred and is not a gate for this
extraction's implementation handoff.

This is an implementation completion record, not a claim that deferred native
checks passed. The pointer-echo fix in #1938, modifier-shortcut acceptance, and
any unreported visual checks remain on the later QA list. A new concrete failure
should be handled as a focused follow-up, preserving the completed foundation.

## Delivered milestones

Each implementation cycle was merged through its own worktree and squash PR.

| PR                                                       | Delivered behavior                                                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [#1931](https://github.com/ArcaneArts/Cantrip/pull/1931) | Shared cursor state, identity color, geometry, presentation, rendering, and motion.                 |
| [#1932](https://github.com/ArcaneArts/Cantrip/pull/1932) | Shared typed input, timeline execution, and participant hold ownership.                             |
| [#1933](https://github.com/ArcaneArts/Cantrip/pull/1933) | Native gestures use the shared input host with fallible dispatch and scoped cleanup.                |
| [#1934](https://github.com/ArcaneArts/Cantrip/pull/1934) | Persistent native input sessions and reusable macOS cursor renderer.                                |
| [#1935](https://github.com/ArcaneArts/Cantrip/pull/1935) | Independent per-session native input jobs and bounded progress updates.                             |
| [#1936](https://github.com/ArcaneArts/Cantrip/pull/1936) | Shared lazy drag timing and removal of the legacy short drag cap.                                   |
| [#1937](https://github.com/ArcaneArts/Cantrip/pull/1937) | Compatibility actions use shared ownership; integration guide and overhead measurement.             |
| [#1938](https://github.com/ArcaneArts/Cantrip/pull/1938) | Private legacy background event state and explicit preparation coordinates; native retest deferred. |

## Completion audit

The shared core contains no native framework, agent-turn, MCP, remote-desktop, or
browser-engine dependency. Existing CUA cursor compatibility exports reference
the shared implementation. Native typed gestures and legacy semantic actions
use participant ownership, and CUA still owns authorization and lifecycle.
Runtime tests cover independent session progress, ordered same-session input,
scoped cancellation, and cleanup after delivery panic or transport failure.

The extension points are usable today: `InputBackend`, `InputHost`,
`CursorTarget`, `CursorSource`, `CursorRenderer`, typed coordinate transforms,
and immediate/eased/scheduled motion. Native consumers can use `NativeInputHost`,
`NativeInputSession`, and `MacOsCursorRenderer`. Their adapter supplies permissions,
identity, target resolution, lifecycle, and transport. No agent evaluator is
required to use the foundation. See `INTERACTION_FOUNDATION.md` for usage.

Known backend constraints are explicit rather than unfinished extraction:
macOS composition is unsupported, native media actions are system-wide, and
an application may share mouse/keyboard state across windows. Logical ownership
cannot make an application expose multiple independent drag contexts. Future
adapters must share the native host where application state is shared.

Local verification during the milestones covered shared-core/native Rust tests,
JavaScript and worker input contracts, Rust formatting and Clippy, scoped cleanup,
and the software-only benchmark below. The latest input fix passed the full
native suite and the final focused macOS tests. No live desktop input or app
restart was performed for that fix; no CI jobs were added or manually triggered.

## Evidence map

| Requirement                                                          | Implementation and focused evidence                                                                                                                                                                                                                            |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core independent of agent/transport/platform                         | `cantrip_interaction/Cargo.toml`, `src/input.rs`, `src/presentation.rs`, and `src/host.rs`; dependencies contain no CUA, browser, MCP, or native framework. Native backend and CUA authority remain in `cantrip_cua`.                                          |
| Independent participant identity, stable color, geometry             | `cursor.rs`, `geometry.rs`, `presentation.rs`; `tests/foundation.rs`; native service tests cover scope mismatch, target generations, resizing, cursor styles and capture composition.                                                                          |
| Immediate, ease-out, scheduled and drag paths                        | `motion.rs` and `schedule.rs`; zero/extreme duration, exact endpoint, cancellation, and scheduling tests. Native drag consumes the shared lazy path.                                                                                                           |
| Persistent keys/buttons, modifiers, cleanup and shared app conflicts | `host.rs`, `ownership.rs`, `tests/input_host.rs`, `tests/input_ownership.rs`; native packet and session tests verify modifiers, button routing, retained release position, private sources, scoped cleanup, and repeated capacity reuse without desktop input. |
| All existing input routes use shared lifetime                        | Native `gesture.rs` compiles ordinary input through `NativeInputSession`; `MacOsBackend::input_action` routes legacy clicks and AX press; focus uses the semantic-action hook. Existing native delivery code remains behind the adapter.                       |
| Honest receipts; no uncertain replay or implicit global fallback     | `PostFailure`, sequence fencing and scoped cleanup tests; ordinary native delivery and explicit global compatibility actions remain separate. Capture/observation is required to establish application response.                                               |
| Long work does not block unrelated sessions                          | `cantrip_cua/src/runtime.rs` input jobs; `tests/runtime.rs` channel-based concurrency, same-session ordering, exact-binding lifecycle cancellation, wrong-binding isolation, panic, EOF and output-failure tests.                                              |
| No arbitrary playback-duration cap                                   | Safe-integer drag/timeline/hold validation; lazy samples; `wait_for_offset`; JavaScript/worker gesture-contract and timeline-deadline tests. Active JavaScript CPU, frame/source sizes, pending requests and native shutdown remain separately bounded.        |
| Capture, cursor layers and effects                                   | Existing clean capture configuration, native cursor/effect panels, defaults, rendering/telemetry/uniform tests remain in CUA; native visual acceptance pending below. Effects remain off by default.                                                           |
| Host activity and adapter authority                                  | Native input cancellation is supplied by the authorized operation/lifecycle; human input does not create cancellation tokens. CUA binding checks remain in service/worker; shared host APIs confer no permissions or agent authority.                          |
| Platform capabilities and future adapters                            | `InputCapabilities`, native unsupported-composition result, and `INTERACTION_FOUNDATION.md` extension points and examples. Shared contracts require neither a process ID nor a macOS window.                                                                   |
| Resource use and overhead                                            | Fixed-size progress, bounded trails/queues, lazy motion, close/Drop and native-source cleanup tests; repeatable `examples/overhead.rs` software-only benchmark.                                                                                                |

## Local software measurement

On macOS/aarch64, a release run after three warmups measured 21 batches of
200,000 events. The direct recording backend measured 0.695 ns/event median
(0.715 ns p95); the shared host measured 39.904 ns/event median (44.686 ns p95).
Participant open/close measured 86.787 ns median (90.963 ns p95).

These are a minimal recording backend and in-process bookkeeping, not desktop
input latency, a before/after product benchmark, or a performance guarantee.
Re-run the documented command on the deployment machine when evaluating overhead.

## Deferred native QA checklist

When the user chooses to resume live QA, load the merged helper normally and
use the existing Brave piano and a scratch text editor. No other apps or messages need to be changed.

1. Keep Brave unfocused and partly covered. Ask an agent to reuse its attachment,
   click three visible piano keys, then drag across five adjacent white keys over
   three seconds. Confirm notes sound, the custom cursor travels/glows smoothly,
   and the host cursor/focus remain yours.
2. Ask for a ten-second repeating keyboard chord. Play alongside it using your
   own keyboard/mouse, then explicitly stop the agent midway. Confirm human input
   does not cancel playback, Stop stops it, and no note/button stays held. Ask
   for one further note to verify a fresh authorized turn works.
3. In a scratch editor, ask for `Hello`, Enter, `world`, then select the text with
   a modifier shortcut and scroll. Confirm text/keys/modifiers/scroll still work.
4. If effects are enabled for your test, briefly select inversion. Confirm the
   host sees the effect, the cursor remains above it, and an agent screenshot
   remains unfiltered. Return the effect to your preferred setting afterward.

Report which step fails, whether the host pointer or focus changed unexpectedly,
and any exact tool error. No success claim should rely solely on `dispatched` or
`windowDelivery: unverified`. This check validates ordinary native delivery and
presentation; explicit global/process compatibility methods retain their separate
side-effect semantics and should only be used when specifically requested.

## Deferred physical-pointer echo retest

The follow-up isolates legacy background event sources and gives the native
preparation down/up records finite off-window coordinates instead of unspecified
(NaN) window locations. Buffer-level tests verify these changes; they do not
establish how Brave interprets the records.

Ask the agent to repeat one piano key five times, holding each press for 200 ms
with a one-second gap. Keep your pointer stationary over a different key without
clicking; then repeat while moving across keys without pressing any button. Only
the agent's selected note should sound. Finally repeat with Brave unfocused to
confirm background delivery still works. Report stationary and moving results
separately. A remaining moving-only echo could instead be the page's shared drag
state; do not suppress human input or declare isolation proven from dispatch.
