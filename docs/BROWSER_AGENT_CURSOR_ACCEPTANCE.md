# Managed browser agent cursor

Cantrip's managed headless Browser surface now shows one agent cursor above its
video. Explicit Browser targets in web sessions borrow that visible CDP page;
untargeted web research retains its isolated runtime.

## Acceptance evidence

| Requirement | Implementation and automated evidence |
| --- | --- |
| Shared appearance, identity color and glow | `cantrip_interaction/src/sprite.rs` rasterizes shared `CursorState`. `cursor-assets.test.ts` runs the actual helper and checks PNG output, different identities, click artwork and motion metadata. |
| Shared ease-out motion | Native `TRAVEL_POLICY` is serialized with sprites and consumed by `remote-surface/cursor-overlay.tsx`. Overlay tests check timing, resize dimensions, and immediate click/drag placement. |
| One agent cursor; independent user pointer | `BrowserAgentCursor` maintains one epoch/identity per surface. Only `BrowserCdpSession.agentCommand` publishes positions; UI dispatch uses `command`. Unit tests cover identity replacement and late assets. |
| Cursor excluded from observations | Overlay is a sibling of the video canvas in Cantrip, never webpage DOM. Real Chromium acceptance compares PNG screenshots before/after agent cursor movement and requires byte-identical results. |
| CDP only | Managed web click/move/drag/type use target-bound CDP. Sprite generation uses pure rasterization mode, without starting native input or changing host focus. |
| Coordinates | Pointer events use viewport CSS pixels. Normalized overlay positions use successfully applied CDP metrics, not pending requests. Real Chromium test verifies scrolling, 800×600 resizing and DPR 2 produce the expected midpoint. Failed-metrics test verifies geometry remains unchanged. |
| User interaction continues | Real Chromium acceptance sends user mouse movement, down/up and keyboard events during an agent drag. It checks both user events and the agent's final release, then successfully performs another agent observation. |
| Order, timing and no replay | Gesture tests cover slow acknowledgements, exact endpoints, zero duration, 150-second holds and release after failure. Presentation has no awaited work in dispatch. Known drag timing produces live linear samples; ordinary moves use shared ease-out. There is no future-click timeline in this API, so it does not invent one or delay clicks for animation. |
| Stop and closure | Broker tests check deactivation, revocation and replacement, preserving view attachment and rejecting stale Stop. Runtime test releases once and reuses the page afterward. Gesture tests cover target loss; renderer/worker tests cover closed cursor suppression. |
| Reconnect and navigation | Cursor snapshot restores position with `click:false`, so reconnect never replays glow/input. Real Chromium test verifies detach/reattach, navigation frames and crash recovery. Navigation hides old cursor position. UI resets on reconnect/runtime recovery; ordered epoch/sequence updates reject stale positions within a cursor lifetime. |
| Startup/capture efficiency | Frame-pipeline test proves identical initialization/attachment/ready requests issue four CDP setup commands rather than twelve. Concurrent screenshots share in-flight work only; completed screenshots are not cached. This is a command-count improvement, not a claimed wall-clock speedup. |
| Existing behavior | Native CUA library, shared interaction, desktop overlay, browser controls, protocol compatibility and worker/app typechecks are included in focused validation. |

## Scope and limitations

- This is the managed headless Browser inside Cantrip, not an external Brave or
  Chrome window on the host desktop. Select that Browser target for agent work.
- Users and agents share DOM focus, selection and the page's mouse/button state.
  Neither session is interrupted by the other, but simultaneous actions can
  affect the same widget or drag. There are no independent OS pointers or
  independent page focus contexts.
- Cursor events describe acknowledged dispatch, not proof that a page accepted
  the action. Use a fresh observation to verify meaningful outcomes.
- UI/network latency still applies. Clicks and drag samples snap to their actual
  positions; animation does not postpone input to compensate for latency.
- Older helpers without motion metadata render immediately. Current helpers
  supply the shared timing. Transient sprite failures retry on subsequent agent
  activity, throttled to one attempt per second.
- Manual desktop visual QA remains deferred to the user; automated tests use a
  separate headless Chromium instance and do not operate the user's browser.

## Short manual test

1. Open a piano or harmless test page in a Cantrip Browser tab. Ask the agent to
   use that exact Browser target, take a fresh observation, and click a few keys.
   Expect one colored cursor and click glow, without moving the system pointer.
2. Ask for movement and a one-second drag via `web_session_pointer`. Watch smooth
   movement and the final release. Cursor placement should agree with the page.
3. While it runs, move/click/type yourself. Agent work should continue without a
   reset or restart request; shared page focus can naturally affect the result.
4. Resize the browser area, scroll, and repeat at fresh coordinates. Detach and
   reopen the view. Expect correct alignment, one cursor and no repeated clicks.
5. Navigate or reconnect, then perform another action. Stop a long held gesture;
   it should release and allow the next turn to use the same page.
6. Compare the agent's screenshot/observation with the displayed view: the
   Cantrip cursor should only appear in the latter.

## Delivery

Each cycle used an isolated worktree and squash automerge:

- #1950: shared sprites and overlay
- #1951: capture setup coalescing and navigation attachment recovery
- #1952: visible Browser target sessions and agent-only cursor updates
- #1953: timed pointer gestures and long-operation transport support
- #1954: sprite retry and immutable dispatch receipts
- #1955: turn-scoped Stop cleanup
- #1956: shared native motion policy

The acceptance cycle adds successful-metrics geometry tracking and expanded real
Chromium coverage for screenshot isolation, resize/scroll/DPR, user interaction,
and reconnect restoration. No CI jobs were added or manually triggered.

Final acceptance run: 40 focused worker tests (including two real Chromium
cases), 17 app tests, eight protocol tests, and app/worker typechecks passed.
The unchanged shared/native layer passed 38 interaction and 134 CUA tests in
#1956, including actual helper sprite transport validation. `git diff --check`
passed for the acceptance cycle.
