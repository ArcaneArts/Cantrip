// Recovery uses the actual browser API and full worker. The database
// connection supplies read-only witnesses for the original and recovered lane.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { eventually } from "./full-worker.mjs";
import { interruptGoalLaneDependency } from "./goal-lane-dependency-outage.mjs";

const postgres = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("postgres");

function goalLaneDatabase(fixture, chatId) {
  const sql = postgres(fixture.workerFixture.environment.DATABASE_URL, {
    max: 1,
    connection: { default_transaction_read_only: "on" },
  });
  return {
    close: () => sql.end({ timeout: 5 }),
    async read() {
      const [state] = await sql`
        SELECT c.status AS chat_status, t.state AS task_state,
          d.state AS cycle_state, d.codex_thread_id AS thread_id,
          d.goal_input #>> '{terminal,projectedAt}' AS original_projected_at,
          d.goal_input #>> '{receipt,executionLaneId}' AS original_lane_id,
          d.goal_input #>> '{receipt,executionLaneActivatedAt}' AS original_activation,
          d.goal_cycle_recovery #>> '{suspension,terminal,observedAt}' AS cycle_observed_at,
          d.goal_cycle_recovery #>> '{suspension,terminal,projectedAt}' AS cycle_projected_at,
          d.goal_cycle_recovery #>> '{suspension,terminal,turnId}' AS cycle_turn_id,
          l.id AS lane_id, l.state AS lane_state, l.purpose,
          l.activated_at::text AS activation, origin.state AS original_lane_state,
          s.revision AS queue_revision, s.notified_revision
        FROM chats c JOIN tasks t ON t.chat_id=c.id
        JOIN task_dispatch_cycles d ON d.chat_id=c.id AND d.operation_kind='finalize'
        LEFT JOIN chat_execution_lanes l ON l.chat_id=c.id AND l.state='active'
        LEFT JOIN chat_execution_lanes origin
          ON origin.id=d.goal_input #>> '{receipt,executionLaneId}' AND origin.chat_id=c.id
        LEFT JOIN managed_queue_states s ON s.chat_id=c.id
        WHERE c.id=${chatId}
        ORDER BY d.created_at DESC,d.id DESC LIMIT 1
      `;
      return state;
    },
  };
}

async function observeCommittedBeforeLoss(chatId, file, db, evidence) {
  evidence.beforeLoss = await eventually(
    () =>
      readFile(file, "utf8").then(JSON.parse, (error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }),
    (record) => {
      assert.equal(record?.committed, true);
      assert.equal(record.chatId, chatId);
      assert.ok(record.heldObservations.length > 0);
    },
  );
  evidence.committedState = await db.read();
  assert.equal(evidence.committedState.task_state, "implementing");
  assert.equal(evidence.committedState.lane_id, evidence.recovered.lane_id);
  assert.equal(
    evidence.committedState.cycle_turn_id,
    evidence.beforeLoss.turnId,
  );
  assert.ok(evidence.committedState.cycle_observed_at);
  assert.equal(evidence.committedState.cycle_projected_at, null);
}

async function interruptOwner(fixture, workerId, before, evidence) {
  evidence.peerReplacement = await fixture.replacePeer(
    1,
    fixture.peers[1].kind,
    {
      crash: true,
    },
  );
  const after = await eventually(
    () => fixture.workerClaim(workerId),
    (claim) => {
      assert.equal(
        claim?.instanceId,
        evidence.peerReplacement.after.instanceId,
      );
      assert.notEqual(claim.connectionId, before.connectionId);
      assert.deepEqual(claim.continuityIdentity, before.continuityIdentity);
    },
  );
  return after;
}

export async function activateRecoveredGoalLane({
  fixture,
  page,
  chatId,
  completeGoal,
  worker,
  workerId,
  faultFile,
  dependency,
  cluster,
  result,
}) {
  const db = goalLaneDatabase(fixture, chatId);
  const evidence = (result.taskGoalRecoveredLane = {});
  try {
    await eventually(
      () => completeGoal.entered,
      (entered) => assert.equal(entered, true),
    );
    evidence.beforeRecovery = await eventually(db.read, (state) => {
      assert.ok(state?.original_projected_at);
      assert.equal(state.task_state, "implementing");
      assert.equal(state.chat_status, "idle");
      assert.equal(state.lane_id, null);
    });
    const recovered = await page.evaluate(
      async (chat) =>
        (await import("/src/lib/api/tasks.ts")).recoverTaskImplementation(chat),
      chatId,
    );
    assert.equal(recovered.state, "implementing");
    evidence.recovered = await eventually(db.read, (state) => {
      assert.equal(state?.chat_status, "running");
      assert.equal(state.lane_state, "active");
      assert.equal(state.purpose, "Recovered native Task Goal");
      assert.equal(state.lane_id, state.original_lane_id);
      assert.notEqual(
        new Date(state.activation).toISOString(),
        state.original_activation,
      );
      assert.equal(state.thread_id, evidence.beforeRecovery.thread_id);
    });
    completeGoal.release();
    if (faultFile) {
      const before = await fixture.assertRemoteWorker(workerId);
      const workerPid = worker.child.pid;
      await observeCommittedBeforeLoss(chatId, faultFile, db, evidence);
      const after = dependency
        ? await interruptGoalLaneDependency({
            fixture,
            workerId,
            before,
            dependency,
            cluster,
            faultFile,
            db,
            evidence,
          })
        : await interruptOwner(fixture, workerId, before, evidence);
      assert.equal(worker.child.pid, workerPid);
      assert.equal(worker.child.exitCode, null);
      assert.equal(worker.child.signalCode, null);
      evidence.worker = {
        pid: workerPid,
        before: before.connectionId,
        after: after.connectionId,
      };
    }
  } catch (error) {
    evidence.failureState = await db.read();
    throw error;
  } finally {
    completeGoal.release();
    await db.close();
  }
}

export async function observeSettledGoalLane(fixture, chatId, result) {
  const db = goalLaneDatabase(fixture, chatId);
  const evidence = result.taskGoalRecoveredLane;
  try {
    evidence.settled = await eventually(db.read, (state) => {
      assert.equal(state?.chat_status, "idle");
      assert.equal(state.task_state, "complete");
      assert.equal(state.cycle_state, "succeeded");
      assert.equal(state.lane_id, null);
      assert.equal(state.original_lane_id, evidence.recovered.lane_id);
      assert.equal(state.original_lane_state, "suspended");
      assert.equal(state.thread_id, evidence.recovered.thread_id);
      assert.ok(state.cycle_projected_at);
      assert.equal(state.notified_revision, state.queue_revision);
      if (evidence.beforeLoss) {
        assert.equal(state.cycle_turn_id, evidence.beforeLoss.turnId);
        assert.equal(evidence.beforeLoss.status, 200);
        assert.ok(
          evidence.beforeLoss.heldObservations.some(
            (reply) => reply.observeExecution,
          ),
        );
        if (fixture.workerFixture.kind === "rust") {
          assert.ok(
            evidence.committedState.queue_revision >
              evidence.recovered.queue_revision,
            "a Rust receipt must advance its durable notification revision",
          );
        }
      }
    });
    result.steps.push(
      "the committed autonomous Goal projects and suspends the exact recovered lane",
    );
    if (evidence.dependencyOutage)
      result.steps.push(
        "the committed Goal is settled after dependency recovery with the original worker and server processes",
      );
    else if (evidence.beforeLoss)
      result.steps.push(
        "the replacement peer projects the committed receipt through the original worker connection continuity",
      );
  } catch (error) {
    evidence.failureState = await db.read();
    throw error;
  } finally {
    await db.close();
  }
}
