// Fault injection around the existing Agent/Goal acceptance assertions. The
// native turn, Goal tools, protected history and full worker stay real.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadStoredWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { eventually } from "./full-worker.mjs";

const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");

async function activeNativeState(sql, chatId) {
  return sql.begin(async (transaction) => {
    await transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    const result = {};
    for (const table of [
      "native_commands",
      "native_command_activations",
      "native_command_turns",
      "chat_execution_lanes",
      "managed_queue_claims",
    ]) {
      const rows = await transaction.unsafe(
        `SELECT to_jsonb(r) AS row FROM ${table} r WHERE r.chat_id=$1 ORDER BY to_jsonb(r)::text`,
        [chatId],
      );
      result[table] = rows.map((row) => row.row);
    }
    return result;
  });
}

function assertRetainedNative(before, after, promptId) {
  const activations = before.native_command_activations.filter((a) => a.active);
  assert.equal(activations.length, 1);
  const activation = activations[0];
  assert.deepEqual(
    after.native_command_activations,
    before.native_command_activations,
  );
  const root = before.native_commands.find(
    (command) => command.operation_id === activation.operation_id,
  );
  assert.ok(root);
  assert.equal(root.execution_completed_at, null);
  const retained = after.native_commands.find(
    (command) => command.operation_id === root.operation_id,
  );
  assert.deepEqual(
    retained,
    root,
    "the exact unfinished native command survives peer loss",
  );
  assert.deepEqual(
    after.native_command_turns,
    before.native_command_turns,
    "peer loss preserves the original observed native turn identity",
  );
  const lane = (state) =>
    state.chat_execution_lanes.find(
      (lane) => lane.id === activation.execution_lane_id,
    );
  assert.deepEqual(lane(after), lane(before));
  assert.equal(lane(after)?.state, "active");
  const claims = (state) =>
    state.managed_queue_claims.filter((claim) => claim.prompt_id === promptId);
  assert.equal(claims(before).length, 1);
  assert.deepEqual(claims(after), claims(before));
}

export function nativeAgentInterruption({
  fixture,
  page,
  projectId,
  workerId,
  getWorker,
  dataDirectory,
  result,
  peer,
}) {
  const shared = peer !== undefined;
  if (shared) assert.ok(["client", "worker"].includes(peer));
  const report = (result[
    shared ? "sharedAgentInflight" : "singleAgentInflight"
  ] = { phases: [], ...(shared ? { peer } : {}) });
  let originalPid, originalCredential;
  return async ({ phase, reply, model, chatId, admitted, objective }) => {
    const worker = getWorker();
    const entry = { phase, chatId, admitted };
    report.phases.push(entry);
    const sql = shared
      ? postgres(fixture.environment.DATABASE_URL, { max: 1 })
      : undefined;
    const posts = () =>
      model.requests.filter((r) => r.method === "POST").length;
    const snapshot = () =>
      page.evaluate(
        async ({ projectId, chatId, phase }) => {
          const api = await import("/src/lib/api/chats.ts");
          return {
            chat: (await api.getChats(projectId)).find((c) => c.id === chatId),
            messages: await api.getMessages(chatId),
            goal: phase === "goal" ? await api.getChatGoal(chatId) : null,
            live: window.folderLive.snapshot(),
          };
        },
        { projectId, chatId, phase },
      );
    try {
      await eventually(
        () => reply.entered,
        (entered) => assert.equal(entered, true),
      );
      originalPid ??= worker.child.pid;
      originalCredential ??= loadStoredWorkerCredential(
        dataDirectory,
        (fixture.workerFixture ?? fixture).server.origin,
      );
      const beforePosts = posts();
      assert.equal(reply.request.completed, false);
      assert.equal(reply.request.closed, false);
      entry.beforeCrash = await snapshot();
      if (phase === "goal") {
        assert.equal(entry.beforeCrash.goal.goal.status, "active");
        assert.equal(entry.beforeCrash.goal.goal.objective, objective);
        assert.equal(entry.beforeCrash.goal.goal.tokenBudget, 1000);
      }
      if (shared) {
        entry.beforeNative = await activeNativeState(sql, chatId);
        entry.beforeClaim = await fixture.assertRemoteWorker(workerId);
        const index = peer === "worker" ? 1 : 0;
        entry.restart = await fixture.replacePeer(
          index,
          fixture.peers[index].kind,
          { crash: true },
        );
        entry.afterClaim = await eventually(
          () => fixture.workerClaim(workerId),
          (claim) => {
            assert.equal(
              claim?.instanceId,
              fixture.workerFixture.environment.CANTRIP_SERVER_INSTANCE_ID,
            );
            assert.ok(claim.connectionId);
            if (peer === "client")
              assert.equal(claim.connectionId, entry.beforeClaim.connectionId);
            else
              assert.notEqual(
                claim.connectionId,
                entry.beforeClaim.connectionId,
              );
          },
        );
      } else entry.restart = await fixture.restart({ crash: true });
      await eventually(
        () => page.evaluate(() => window.folderWorkers.getWorkers()),
        (workers) =>
          assert.equal(
            workers.find((w) => w.workerId === workerId)?.online,
            true,
          ),
      );
      await eventually(
        () => page.evaluate(() => window.folderLive.snapshot()),
        (live) => {
          assert.equal(live.status, "live");
          assert.equal(live.activeScopeCount, live.desiredScopeCount);
        },
      );
      assert.equal(worker.child.pid, originalPid);
      assert.equal(worker.child.exitCode, null);
      assert.equal(worker.child.signalCode, null);
      assert.deepEqual(
        loadStoredWorkerCredential(
          dataDirectory,
          (fixture.workerFixture ?? fixture).server.origin,
        ),
        originalCredential,
      );
      assert.equal(reply.request.completed, false);
      assert.equal(
        reply.request.closed,
        false,
        "the original managed native model response remains open across server restart",
      );
      assert.equal(
        posts(),
        beforePosts,
        "server interruption cannot submit another inference",
      );
      entry.afterReconnect = await snapshot();
      if (shared) {
        entry.afterNative = await activeNativeState(sql, chatId);
        assertRetainedNative(
          entry.beforeNative,
          entry.afterNative,
          admitted.prompt.id,
        );
        assert.deepEqual(
          entry.afterClaim.continuityIdentity,
          entry.beforeClaim.continuityIdentity,
        );
      }
      assert.equal(entry.afterReconnect.chat.id, entry.beforeCrash.chat.id);
      assert.ok(
        ["offline", "running", "waiting-for-approval"].includes(
          entry.afterReconnect.chat.status,
        ),
        "a held native turn cannot become failed or completed because the server restarted",
      );
      assert.equal(
        entry.afterReconnect.chat.hasUnreadCompletion,
        entry.beforeCrash.chat.hasUnreadCompletion,
        "server interruption cannot manufacture a completion",
      );
      if (phase === "goal") {
        const before = entry.beforeCrash.goal.goal;
        const after = entry.afterReconnect.goal.goal;
        const accounting = ["tokensUsed", "timeUsedSeconds", "updatedAt"];
        const stable = (goal) =>
          Object.fromEntries(
            Object.entries(goal).filter(([key]) => !accounting.includes(key)),
          );
        assert.deepEqual(stable(after), stable(before));
        for (const field of accounting) {
          assert.ok(Number.isSafeInteger(before[field]) && before[field] >= 0);
          assert.ok(
            Number.isSafeInteger(after[field]) && after[field] >= before[field],
            `active Goal ${field} cannot regress across server interruption`,
          );
        }
      }
      entry.retained = {
        workerPid: originalPid,
        modelPosts: posts(),
        originalStreamOpen: true,
      };
      result.steps.push(
        `${shared ? "shared server " + peer : "single server"} ${phase} SIGKILL preserves the same worker, original native model stream and live subscriptions`,
      );
      report.summary = {
        ...(shared ? { peer } : {}),
        phases: report.phases.map((entry) => entry.phase),
        workerRetained: true,
        originalStreamsRetained: true,
      };
    } catch (error) {
      entry.failure = { message: error.message, stack: error.stack };
      throw error;
    } finally {
      reply.release();
      await sql?.end();
    }
  };
}
