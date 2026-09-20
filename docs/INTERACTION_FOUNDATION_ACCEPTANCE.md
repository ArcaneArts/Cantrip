# Interaction foundation acceptance

The extraction is implemented through CUA. Remote desktop and embedded-browser
integration are intentionally absent. Native application acceptance below is
still pending; do not infer it from event dispatch receipts or unit-test results.

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

## Native check required from the user

After loading the merged helper normally, use the existing Brave piano and a
scratch text editor. No other apps or messages need to be changed.

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
