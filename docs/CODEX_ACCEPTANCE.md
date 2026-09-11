# Codex CLI/GUI acceptance status

This reconciles the original 23-row matrix in
[CODEX_AUDIT.md](CODEX_AUDIT.md#acceptance-and-diagnostic-plan) through pass 80.
The user confirmed the complete remaining demo on September 11, 2026:
“Yes it all works confirmed.” Together with the recorded automated acceptance,
this closes the scoped CLI/GUI integration goal. Historical findings in the
audit describe the original baseline, not current defects.

## Final acceptance

- Pass 77 ([#1927](https://github.com/ArcaneArts/Cantrip/pull/1927)) completed
  the top-level renderer bindings and reduced default console output. The user
  confirmed switching into CLI worked; the remaining symptom was repeated
  redraws inside the terminal.
- Pass 78 ([#1928](https://github.com/ArcaneArts/Cantrip/pull/1928)) prevents a
  receipt settlement failure from closing the native CLI connection. An actual
  pinned-TUI regression reproduces the reconnect loop before the fix and stays
  on one connection afterward. All 25 focused tests passed. The user subsequently
  reported the result was looking good and requested continuation.
- The original production receipt failure's cause remains unconfirmed. The new
  rate-limited diagnostic records the affected method and server cause code if
  it recurs. No claim is made that every backend receipt failure is resolved.

**User acceptance received:** the confirmation answers the pending full demo
checklist, covering cross-view work/history, settings and controls, attachments
and interactions, piano/duet behavior, and mobile/multi-window checks. This is
user-reported acceptance, not a new instrumented run or direct CUA observation
by the implementation agent. No additional screenshots, timings or per-step
thread IDs were supplied or inferred.

## Evidence boundary

Native acceptance uses the actual pinned Codex 0.153.4 with reviewed Cantrip
patches, isolated homes, local synthetic providers and MCP peers. Where named,
the fixtures include a real PTY, worker controllers, server admission and
encrypted durable history. Mounted React tests use simulated server responses;
they do not establish rendered desktop behavior. Fake CUA tests exercise
authority and transport without operating the user's computer.

The four completed 150-second cases from pass 62 remain evidence for request
lifetime. They do not prove macOS input delivery, piano audio or a human duet.
Pass 80 records final user acceptance only. No new private account inference,
user worker restart, desktop input or CI job was performed.

## Original matrix reconciliation

The evidence column describes the automated layer actually exercised. The last
column retains the requested demo criteria, accepted by the user's September 11
confirmation of the whole checklist. It does not invent separate measured
results for each row. Test files below are under `cantrip_worker/test` unless
another location is stated. Native tests
require an explicitly selected binary; an ordinary invocation may skip them.

| #   | Original requirement                         | Automated evidence                                                                                                                                                                                                                                        | User-confirmed demo criteria                                                                    |
| --- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | Empty tab preboot                            | Server `native-managed-chat-preparation.test.ts` binds and attaches one real CLI without provider requests. App preparation-status tests cover state display.                                                                                             | Observe a new tab staying in GUI with its CLI already attached.                                 |
| 2   | Creation/first-send/attach race              | `native-managed-worker-session.test.ts` joins concurrent preparation; server `managed-startup-api.test.ts` covers accepted input identity, retry and Stop during startup.                                                                                 | Immediate first send in the actual GUI.                                                         |
| 3   | MCP enabled/disabled/config edit             | `native-empty-thread-attach.test.ts` and `native-managed-worker-session.test.ts` check initialization, catalogs, harmless calls, credential refresh, reserved names and explicit configuration.                                                           | Confirm the current computer-use setting in the demo.                                           |
| 4   | Metadata/goal/plan reads                     | `native-thread-observation.test.ts` checks settings, instructions and MCP retention. Server admission regressions cover skill/hook discovery across turn boundaries and reject another runtime.                                                           | Combined demo.                                                                                  |
| 5   | Attach idle/active with conflicting defaults | `native-managed-tui-attach.test.ts` covers physical reopen/cold join with conflicting hints. Native command-session tests cover active work.                                                                                                              | Compare settings while switching views.                                                         |
| 6   | CLI-first and GUI-first work                 | `native-managed-command-session.test.ts` and `native-shared-steering.test.ts` check both origins, native TUI output, accepted input, outcomes and encrypted history.                                                                                      | Compare actual GUI transcript/activity and CLI.                                                 |
| 7   | Shared-turn GUI input plus CLI steering      | `native-shared-steering.test.ts` checks exact-once inputs/items in one native turn, in both directions.                                                                                                                                                   | Combined presentation comparison.                                                               |
| 8   | Stop each direction                          | Native command-session, shared-pause and child-CUA tests cover interruption and successor authority. App linked-console tests keep Stop usable during pending Pause.                                                                                      | Use both Stop controls and verify the next turn works.                                          |
| 9   | Follow-up during work/just after completion  | `native-managed-queue-execution.test.ts`, `native-managed-queue-tui.test.ts` and command-session tests cover canonical IDs, settlement and one queue owner.                                                                                               | Queue/acceptance visibility in the GUI.                                                         |
| 10  | Approval/question reply in either surface    | `native-shared-interactions.test.ts` covers both directions, physical reopen, cancellation and duplicate rejection. `native-shared-elicitation.test.ts` checks both native tool approval and the actual MCP peer's form, with one admitted reply each.    | One visible request resolves in both views. External OAuth URL authorization was not exercised. |
| 11  | `/model`, composer and native selection      | App `use-settings-slash-commands.test.tsx` opens the shared picker; `native-inherited-turn-settings.test.ts` checks the model/effort in the next real provider request. Replacement/account tests check retention.                                        | Select through both actual surfaces and compare effective settings.                             |
| 12  | Model-picker inventory                       | Native managed-worker tests compare real `model/list` and route attribution. App native-model-picker tests use the bound inventory.                                                                                                                       | Compare visible eligible choices for the user's account.                                        |
| 13  | Concurrent settings/active-turn edit         | `native-settings-correlation.test.ts` checks queued/applied identities and ordered versions. App picker tests preserve pending desired choices; replacement-settings tests preserve turn attribution.                                                     | Observe pending/effective settings during work.                                                 |
| 14  | Defaults/routes/subagent settings            | `native-managed-account-config.test.ts` checks explicit writes and cold restore; gateway tests deny unadmitted defaults. Inherited-settings tests preserve child settings; managed inventory checks account/route identity.                               | Combined settings demo.                                                                         |
| 15  | Service-tier clear/omit and permissions      | Native settings correlation covers omitted, clear, standard and unset. Inherited-settings tests exercise native permission transitions; app permission tests distinguish pending/unavailable/confirmed state.                                             | Compare effective permissions. This macOS run is not an execution test on other OSes.           |
| 16  | Missed completion with healthy UI            | Projection-capture tests lose a persistence response, remain otherwise idle, retry the exact batch and persist one message. App live-query and console tests refresh without the transcript mounted.                                                      | Completion visibility while switching views.                                                    |
| 17  | Persistence failure after native read        | `native-history-projection.test.ts` and `native-history-outbox.test.ts` cover lost ACK, partial publication, checkpoint/disk failure, reopen and stable retry.                                                                                            | Combined history comparison.                                                                    |
| 18  | Worker/runtime/UI reconnect/restart          | `native-process-recovery.test.ts` and `native-worker-process-recovery.test.ts` cover both origins, active/completed work, questions and child output with stable decrypted history and fresh authority. App retention tests cover presentation lifecycle. | Terminal stability and GUI reconnect/history comparison.                                        |
| 19  | Concurrent snapshot/live history             | Native history foundation, reducer and projection tests cover legacy/paginated live items, stale snapshots, terminal dominance and stable ordering/IDs.                                                                                                   | Combined history comparison.                                                                    |
| 20  | Images/tools/reasoning/children/warnings     | Native history foundation exercises rich native items and restart. Rendering tests preserve sparse summaries, long output and explicit unresolved content. Whole-worker child tests verify encryption and ownership.                                      | Inspect activity details and an image attachment in both views.                                 |
| 21  | Multi-chat/multi-window/mobile               | Native empty-thread/session tests isolate sibling contexts; app terminal retention preserves ownership; linked-console tests target two distinct chats.                                                                                                   | Actual mobile/multi-window resizing, switching and reconnect.                                   |
| 22  | Startup/MCP/provider/auth failure            | First-send/preparation tests expose actual failure phases and preserve input. Native gateway tests deny work before inference; context-recovery tests exercise rejected model context on the retained thread.                                             | Confirm any encountered errors are visible; do not deliberately break personal credentials.     |
| 23  | CUA duet and long timeline                   | Pass 62 completed four 150-second helper-protocol cases. Current native command cases retain both origins, portable tool declarations, explicit Stop and fresh authority.                                                                                 | Unfocused piano delivery/audio, cursor/effects and simultaneous human input.                    |

## Other explicit goal requirements

- Admission precedes native mutations, replies and account-default writes.
  Pass 75 changes only skill/hook discovery's relationship to turn activation.
  Ownership, placement, native runtime/connection and permissions remain checked.
  Stop, replies and CUA retain exact activation authority.
- Provider/account migration has an explicit transfer and recovery path, covered
  by native portable-history/imported-preparation tests and server handoff tests.
  Changing a model string does not masquerade as a provider migration.
- Encryption, stable item identity and durable acknowledgment are checked through
  actual persistence/replay. Full worker restart evidence from passes 69–73 is
  distinct from component reconstruction or restarting only the native process.
- GUI-first presentation and retained terminal ownership are implemented. The
  user confirmed the final desktop/mobile demo. Mounted tests remain separate
  evidence and are not screenshots of the running product.
- The full repository check is not green. Exact results and focused evidence are
  recorded through audit pass 76; failed checks are not counted as successful tests.

## Reproduction

Build dependencies and the worker, and select the reviewed packaged binary:

```sh
export CANTRIP_CODEX_TEST_BINARY=/absolute/path/to/reviewed/codex
export CANTRIP_CUA_TEST_BINARY=/absolute/path/to/cantrip-cua
pnpm --filter @cantrip/worker... build
pnpm --filter @cantrip/worker exec vitest run --maxWorkers=2 \
  test/native-empty-thread-attach.test.ts \
  test/native-thread-observation.test.ts \
  test/native-managed-tui-attach.test.ts \
  test/native-managed-worker-session.test.ts \
  test/native-managed-gateway.test.ts \
  test/managed-native-gateway.test.ts \
  test/native-discovery-receipt-tui.test.ts \
  test/native-managed-account-config.test.ts \
  test/native-inherited-turn-settings.test.ts \
  test/native-settings-correlation.test.ts \
  test/native-replacement-settings-integration.test.ts \
  test/native-managed-context-recovery.test.ts \
  test/native-imported-session-preparation.test.ts \
  test/native-portable-history-transfer.test.ts
pnpm --filter @cantrip/worker exec vitest run --maxWorkers=2 \
  test/native-shared-elicitation.test.ts \
  test/native-shared-interactions.test.ts \
  test/native-shared-steering.test.ts \
  test/native-shared-pause.test.ts \
  test/native-managed-command-session.test.ts \
  test/native-managed-queue-tui.test.ts \
  test/native-managed-queue-execution.test.ts
CANTRIP_REQUIRE_NATIVE_LIVE_HISTORY=1 pnpm --filter @cantrip/worker exec vitest run --maxWorkers=2 \
  test/native-history-foundation.test.ts \
  test/native-history-projection.test.ts \
  test/native-history-outbox.test.ts
```

These CUA fixtures explicitly select `--backend fake`. Full 150-second playback
is a separate opt-in retained in audit pass 62; it was not repeated for this
discovery change. Passes 68–73 retain native/worker crash-recovery evidence.

## Final user implementation demo — confirmed September 11, 2026

The user confirmed that the whole remaining checklist works. The steps below
are retained for future regression testing; they are no longer pending goal
work. Acceptance is based on that user report, without claiming additional
agent-observed desktop testing.

Use the updated app/server/worker and packaged CLI. Create a disposable agent
chat and keep GUI as its initial view.

1. Open CLI before sending anything. Confirm it is already attached with no
   synthetic conversation. Return to GUI, send a short harmless request, and
   switch/resize views while it works.
2. Send the next request from CLI. Compare user input, activity, answer,
   completion status and native thread identity in GUI. Queue a follow-up during
   work and confirm it runs once.
3. Select model/effort using GUI `/model`, then CLI `/model`. Compare the effective
   selection and next turn. Check `/permissions`, pause/resume and Stop from each
   view, followed by another request.
4. Include one image attachment and a harmless question requiring a reply.
   Confirm both presentations show the request and one reply clears it.
5. With computer use enabled, request a few mouse-only notes on the existing
   unfocused piano from each origin. Play alongside it; human input must not
   cancel the agent. Check cursor/effects behavior and explicit Stop.
6. On mobile or multiple windows, switch between two disposable chats. Confirm
   each control affects its own chat and history survives reconnect.

For any mismatch, report input origin, view, thread/turn IDs if visible, and the
actual error or screenshot. Dispatch receipts alone do not prove a note sounded.
Do not resend an uncertain external action just to test recovery.
