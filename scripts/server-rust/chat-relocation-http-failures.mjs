// Exercise production cancellation fences and compensation after real rollback.
import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";
import { json, literal, label, stamp } from "./project-target-state.mjs";

function eventTrace(live, offset) {
  return live.history
    .slice(offset)
    .filter(
      (frame) =>
        frame.type === "event" &&
        ["chat-relocation-job", "chat"].includes(frame.resource),
    )
    .map(({ resource, scope, entityId, revision, action, payload }) => ({
      resource,
      scope,
      entityId,
      revision,
      action,
      payload,
    }));
}
function orderedCommands(commands) {
  assert.equal(commands[0].command.type, "worktree.status");
  assert.equal(commands[1].command.type, "worktree.status");
  return [
    ...commands.slice(0, 2).sort((a, b) => a.worker.localeCompare(b.worker)),
    ...commands.slice(2),
  ];
}
export async function relocationFailures({
  fixture,
  state,
  live,
  reset,
  visit,
  read,
  waitJob,
  owner,
  projectId,
  target,
  stateQuery,
  normal,
  startedAt,
}) {
  const results = [];
  for (const mode of [
    "cancel-active-hydration",
    "branch-conflict-compensation",
  ]) {
    await reset();
    state.mode = mode;
    let release;
    state.hydrationBarrier = new Promise((resolve) => {
      release = resolve;
    });
    const commandOffset = state.commands.length,
      eventOffset = live.history.length;
    try {
      const job = await visit(
        mode + " admission",
        "POST",
        "/api/chats/chat/relocations",
        { status: 202, json: { target, approved: true, idempotencyKey: mode } },
      );
      await eventually(
        () => state.commands.slice(commandOffset),
        (commands) =>
          assert.equal(
            commands.filter(
              (call) =>
                call.command.type === "chat.relocation.hydration.complete",
            ).length,
            1,
          ),
      );
      const hydrating = await read(`/api/chat-relocations/${job.id}`);
      assert.equal(hydrating.state, "hydrating-runtime");
      assert.equal(hydrating.stateRevision, 5);
      assert.equal(hydrating.cancellationUnsafeAt, null);
      if (mode === "branch-conflict-compensation")
        await fixture.sql([
          `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,created_at,updated_at,last_used_at) VALUES('branch-holder',${literal(owner)},${literal(projectId)},'github-beta-main','beta',${json(label("chat"))},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
          `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,created_at,updated_at) VALUES('holder-lane','branch-holder','github-beta-main','beta','user',false,'Other chat','active',${literal(stamp)},${literal(stamp)})`,
          `INSERT INTO project_branch_leases(id,project_id,branch_name,chat_execution_lane_id,worktree_id,worker_id,state,created_at,updated_at) VALUES('holder-lease',${literal(projectId)},'main','holder-lane','github-beta-main','beta','active',${literal(stamp)},${literal(stamp)})`,
        ]);
      const [before] = await fixture.sql([], [stateQuery]);
      if (mode === "cancel-active-hydration") {
        await visit(
          mode + " stale revision",
          "POST",
          `/api/chat-relocations/${job.id}/cancel`,
          { status: 409, json: { stateRevision: hydrating.stateRevision - 1 } },
        );
        const cancelled = await visit(
          mode + " current revision",
          "POST",
          `/api/chat-relocations/${job.id}/cancel`,
          { json: { stateRevision: hydrating.stateRevision } },
        );
        assert.equal(cancelled.state, "cancelled");
        assert.equal(cancelled.stateRevision, 6);
      }
      state.hydrationBarrier = null;
      release();
      const settled = await waitJob(
        job.id,
        mode === "cancel-active-hydration" ? "cancelled" : "blocked",
      );
      await eventually(
        () => state.commands.slice(commandOffset),
        (commands) =>
          assert.equal(
            commands.filter(
              (call) =>
                call.command.type === "chat.relocation.thread.release" &&
                call.command.discard === true,
            ).length,
            1,
          ),
      );
      assert.equal(
        state.snapshots.get(job.id).threadId,
        undefined,
        "Discard actually removes the uncommitted controlled worker thread",
      );
      await live.message(
        (frame) =>
          frame.type === "event" &&
          frame.resource === "chat-relocation-job" &&
          frame.entityId === job.id &&
          frame.revision === settled.stateRevision,
      );
      await live.ping(mode + " settled");
      const [after] = await fixture.sql([], [stateQuery]);
      assert.deepEqual(
        { ...after, jobs: before.jobs },
        before,
        "Cancelled or rolled-back relocation preserves placement, sessions, lanes, leases, terminals and immutable encrypted snapshots",
      );
      assert.equal(after.jobs[0].command_id, null);
      assert.equal(after.jobs[0].lease_expires_at, null);
      assert.equal(
        after.chats.find((chat) => chat.id === "chat").active_worker_id,
        "alpha",
      );
      const events = eventTrace(live, eventOffset);
      assert.deepEqual(
        events
          .filter((event) => event.resource === "chat-relocation-job")
          .map((event) => event.revision),
        mode === "cancel-active-hydration"
          ? [1, 3, 4, 5, 6]
          : [1, 3, 4, 5, 6, 7],
      );
      if (mode === "branch-conflict-compensation")
        assert.deepEqual(settled.error, {
          code: "worker-error",
          retryable: true,
        });
      const observation = {
        name: mode,
        job: normal(fixture, settled, "", startedAt),
        before: normal(fixture, before, "", startedAt),
        after: normal(fixture, after, "", startedAt),
        commands: normal(
          fixture,
          orderedCommands(state.commands.slice(commandOffset)),
          "",
          startedAt,
        ),
        events: normal(fixture, events, "", startedAt),
      };
      results.push(observation);
      if (mode === "branch-conflict-compensation") {
        await fixture.sql([
          "DELETE FROM project_branch_leases WHERE id='holder-lease'",
          "DELETE FROM chat_execution_lanes WHERE id='holder-lane'",
          "DELETE FROM chats WHERE id='branch-holder'",
        ]);
        const retryCommands = state.commands.length,
          retryEvents = live.history.length;
        const retried = await visit(
          mode + " retry",
          "POST",
          `/api/chat-relocations/${job.id}/retry`,
          { json: { stateRevision: settled.stateRevision } },
        );
        assert.equal(retried.id, job.id);
        const complete = await waitJob(job.id, "succeeded");
        assert.equal(complete.attempt, 2);
        await eventually(
          () => state.commands.slice(retryCommands),
          (commands) =>
            assert.equal(
              commands.filter(
                (call) =>
                  call.command.type === "chat.relocation.thread.release" &&
                  call.command.discard === false,
              ).length,
              1,
            ),
        );
        await live.message(
          (frame) =>
            frame.type === "event" &&
            frame.resource === "chat-relocation-job" &&
            frame.entityId === job.id &&
            frame.revision === complete.stateRevision,
        );
        await live.ping(mode + " retry settled");
        const [completed] = await fixture.sql([], [stateQuery]);
        assert.equal(completed.jobs.length, 1);
        assert.equal(completed.snapshots.length, 1);
        assert.deepEqual(
          completed.snapshots[0],
          before.snapshots[0],
          "Retry retains the original encrypted snapshot and digest",
        );
        assert.equal(
          completed.chats.find((chat) => chat.id === "chat").active_worker_id,
          "beta",
        );
        assert.equal(
          completed.chats.find((chat) => chat.id === "chat").placement_revision,
          2,
        );
        observation.retry = {
          job: normal(fixture, complete, "", startedAt),
          snapshot: normal(fixture, completed, "", startedAt),
          commands: normal(
            fixture,
            orderedCommands(state.commands.slice(retryCommands)),
            "",
            startedAt,
          ),
          events: normal(fixture, eventTrace(live, retryEvents), "", startedAt),
        };
      }
    } finally {
      state.hydrationBarrier = null;
      release();
    }
  }
  return results;
}
