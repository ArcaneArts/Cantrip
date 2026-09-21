# Shared remote desktop implementation and acceptance

Implementation baseline: PRs [#1940](https://github.com/ArcaneArts/Cantrip/pull/1940),
[#1941](https://github.com/ArcaneArts/Cantrip/pull/1941),
[#1942](https://github.com/ArcaneArts/Cantrip/pull/1942),
[#1943](https://github.com/ArcaneArts/Cantrip/pull/1943),
[#1944](https://github.com/ArcaneArts/Cantrip/pull/1944),
[#1945](https://github.com/ArcaneArts/Cantrip/pull/1945),
[#1946](https://github.com/ArcaneArts/Cantrip/pull/1946), and
[#1947](https://github.com/ArcaneArts/Cantrip/pull/1947).

## Requirement evidence

| Requirement | Implementation and verification |
| --- | --- |
| Independent cursors with shared styling | `cantrip_cua/src/interaction_sprite.rs` renders the shared Rust cursor into transparent assets. Its test checks distinct identity colors, normal/glow pixels and transparency. Client `cursor-overlay.test.tsx` verifies independent peer placement, immediate local movement, own-echo suppression and URL cleanup. |
| Click, drag, wheel, typing, modifiers and held controls | `desktop/participant-input.ts` translates remote messages into shared `InputEvent`s. `desktop-participant-input.test.ts` checks button down/move/up, back button, wheel, text chunks, key repeats, modifier mapping and dual physical Shift holds. Native `interaction.rs` delegates to the same macOS input host used by CUA. |
| Host cursor/focus preserved without global fallback | Production always supplies worker participants. Native input rejects non-surface scope, including host focus and system media. The adapter regression asserts no legacy activation or system-pointer calls. Monitor input is explicitly view-only; unsupported native input is reported, never replaced by global input. Live application delivery remains deferred QA. |
| Scoped cancellation and stale rejection | Binding/handle/sequence checks exist in native participants and the worker bridge. Tests cover ownership mismatch, duplicate/stale sequences, cancelled opens, uncertain dispatch, target replacement and independent cleanup. Reattaching the same remote attachment renews its epoch. Client blur/cancel rotates only that participant. |
| Capture and attachment speed | macOS production uses worker-owned CUA capture, omits disposable legacy startup probes and reuses attachment inventory. Capture-only ownership survives agent cleanup. Adapter tests receive encoded video with zero legacy calls and one initial inventory call. |
| Cursor presentation independent of video | Local motion updates DOM before network throttling; cursor assets/peer positions use control messages. Idle positions are republished when a viewer joins without repeating clicks. Tests cover peer positions arriving before assets. Native capture omits cursor/effect compositing. |
| Recovery without uncertain replay | Observation failure reopens capture with backoff without closing input. Disconnect, suspend and target replacement release capture. Retired helper handles never migrate to the replacement helper. Input failures display a Reconnect action; reconnect creates a fresh epoch and does not replay old actions. |
| Existing authorization | Remote Surface manager, encryption and worker-link grant paths are unchanged. The new bindings are derived inside the worker from the authorized surface/attachment. Native worker operations are rejected by the JavaScript host-action whitelist. Transport tests cover protected ordered frames, grant scope and closed channels. |
| CUA and browser preservation | CUA keeps its agent sessions, cursor snapshots and shared native input implementation. Independent worker lifetimes are separate from agent cancellation. New shared-canvas callbacks are optional; embedded-browser integration was not added. Native library regression suite passed 135 tests at #1945. |

The final audit reran 40 CUA service, participant and capture tests against the
real helper executable with its fake backend, with no skips. Remote Surface
manager and worker-link transport regressions also passed. Earlier milestone
checks covered app/worker typechecking, cursor rendering and native library
behavior; their scope is recorded above and in the linked PRs.

## Measurements and scope

The controlled 200×200 adapter fixture measured 8.6 ms to its first encoded frame
at #1945, with zero legacy startup calls and one inventory lookup. A later run
measured 6.0 ms. These include local routing and encoding with fixture pixels;
they do not measure native ScreenCaptureKit, network transmission or client decode.
The reproducible test is `cantrip_worker/test/desktop-adapter.test.ts`, named
“uses shared capture without startup probes and recovers video without cancelling
input”. The observation transport is also tested against a real helper executable
using `--backend fake` and `CANTRIP_CUA_TEST_BINARY`.

Independent native input is currently macOS-only. Other platforms retain their
capture backend and report unavailable independent input. Display sharing is
view-only. Applications still own shared text focus, selection and drag state:
separate cursors do not create separate application documents or focus contexts.

Capture reuses CUA's screenshot backend per frame and PNG-to-JPEG transcoding.
Hardware video encoding and guaranteed high-resolution frame rates are not
implemented. Capture errors are recoverable but sustained live throughput has not
been benchmarked. Native permission changes or inaccessible windows can still
fail; no speculative eligibility probe prevents attempting authorized capture.

## Deferred user QA

The user explicitly deferred broad native QA until integration was ready. The
following is not recorded as passed and should be run when convenient:

1. Open the same piano window from two remote clients. Move both cursors, click
   and drag across keys. Keep using the host mouse and switching host apps;
   confirm remote actions neither move the host pointer nor steal host focus.
2. In a scratch editor, type, hold/release keys, use Shift selection and scroll.
   Hold both Shift keys and release one; the remaining hold should continue.
3. Disconnect one client while holding a key/button. Confirm its holds release
   and the other client remains usable. Reconnect, then send a new action; old
   actions must not repeat.
4. Cover or move the shared window, switch the remote target, and suspend/resume.
   Confirm frames recover and never silently display the full desktop. Join a
   second viewer while the first cursor is idle; its last position should appear.
5. With an agent also attached, verify its normal CUA controls and captures remain
   usable. If effects are enabled, remote video should remain unfiltered with
   cursors above it.

Report the failing step, target application, whether host focus/pointer changed,
and the exact visible error. A dispatch receipt alone is not proof an application
accepted input. In particular, shared app drag state may still respond to a host
pointer over the same piano; the earlier physical-pointer echo retest remains in
[INTERACTION_FOUNDATION_ACCEPTANCE.md](INTERACTION_FOUNDATION_ACCEPTANCE.md).
