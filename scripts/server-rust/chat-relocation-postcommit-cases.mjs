// Preserve committed target runtimes when a real COMMIT response is lost.
import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";

export async function relocationPostcommit({
  fixture,
  state,
  live,
  reset,
  visit,
  read,
  target,
  stateQuery,
  normal,
  startedAt,
  result,
  faultRuntime,
}) {
  const cases = [];
  for (const denyRead of [false, true]) {
    await reset();
    state.mode = denyRead ? "lost-commit-and-denied-read" : "lost-commit-ack";
    const offset = state.commands.length,
      eventOffset = live.history.length;
    const armed = faultRuntime.arm();
    let revoked = false;
    try {
      const job = await visit(
        state.mode + " admission",
        "POST",
        "/api/chats/chat/relocations",
        {
          status: 202,
          json: { target, approved: true, idempotencyKey: state.mode },
        },
      );
      const committed = await eventually(
        () => armed.committed,
        (value) =>
          assert.ok(
            value,
            "Observe actual backend CommandComplete COMMIT before dropping its response",
          ),
        15000,
      );
      assert.equal(committed.actualCommandComplete, "COMMIT");
      const committedRows = await faultRuntime.admin.unsafe(stateQuery);
      const durable = JSON.parse(committedRows[0].result);
      assert.equal(durable.jobs.length, 1);
      assert.equal(durable.jobs[0].state, "succeeded");
      assert.equal(durable.jobs[0].id, job.id);
      assert.equal(
        durable.chats.find((chat) => chat.id === "chat").active_worker_id,
        "beta",
      );
      const threadId = state.snapshots.get(job.id).threadId;
      assert.ok(threadId);
      assert.equal(durable.jobs[0].target_runtime_thread_id, threadId);
      if (denyRead) {
        await faultRuntime.denyJobRead();
        revoked = true;
      }
      armed.dropAcknowledgement();
      if (denyRead) {
        const error = await eventually(
          () => armed.readDenied,
          (error) =>
            assert.ok(
              error,
              "Actual denied reread after lost commit acknowledgement",
            ),
          15000,
        );
        assert.equal(error.sqlstate, "42501");
        await eventually(
          () => fixture.server.diagnostics(),
          (text) =>
            assert.ok(
              text.includes(
                "Chat relocation failed outside its durable transition",
              ),
              "Actual executor finishes its failed settlement before inspecting the target",
            ),
          15000,
        );
      } else {
        await eventually(
          () => armed.settlementReadCompleted,
          (done) =>
            assert.equal(
              done,
              true,
              "Actor executes its real fenced settlement after rereading the committed job",
            ),
          15000,
        );
      }
      if (revoked) {
        await faultRuntime.restoreJobRead();
        revoked = false;
      }
      const settled = await read(`/api/chat-relocations/${job.id}`);
      assert.equal(settled.state, "succeeded");
      assert.equal(settled.attempt, 1);
      const [after] = await fixture.sql([], [stateQuery]);
      assert.deepEqual(
        after,
        durable,
        "Losing the response cannot undo the already-committed durable state",
      );
      await live.ping(state.mode + " terminal");
      const commands = state.commands.slice(offset);
      const discards = commands.filter(
        (call) =>
          call.command.type === "chat.relocation.thread.release" &&
          call.command.discard === true,
      );
      const targetPreserved =
        discards.length === 0 &&
        state.snapshots.get(job.id).threadId === threadId;
      // Collect both independent implementations before the suite asserts this
      // safety property. A matched bug must still fail overall qualification.
      cases.push({
        name: state.mode,
        actualCommitAcknowledgementDropped: true,
        actualReadDenied: denyRead,
        targetPreserved,
        discardCount: discards.length,
        job: normal(fixture, settled, "", startedAt),
        durable: normal(fixture, after, "", startedAt),
        events: normal(
          fixture,
          live.history
            .slice(eventOffset)
            .filter(
              (frame) =>
                frame.type === "event" &&
                ["chat-relocation-job", "chat"].includes(frame.resource),
            )
            .map(
              ({ resource, scope, entityId, revision, action, payload }) => ({
                resource,
                scope,
                entityId,
                revision,
                action,
                payload,
              }),
            ),
          "",
          startedAt,
        ),
      });
    } finally {
      if (revoked) await faultRuntime.restoreJobRead();
      armed.disarm();
      result.commitWireObservations = structuredClone(
        faultRuntime.observations,
      );
    }
  }
  return cases;
}
