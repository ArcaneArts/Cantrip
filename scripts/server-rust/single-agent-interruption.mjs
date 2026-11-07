// Fault injection around the existing Agent/Goal acceptance assertions. The
// native turn, Goal tools, protected history and full worker stay real.
import assert from "node:assert/strict";
import { loadStoredWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { eventually } from "./full-worker.mjs";

export function singleAgentInterruption({
  fixture,
  page,
  projectId,
  workerId,
  getWorker,
  dataDirectory,
  result,
}) {
  const report = (result.singleAgentInflight = { phases: [] });
  let originalPid, originalCredential;
  return async ({ phase, reply, model, chatId, admitted, objective }) => {
    const worker = getWorker();
    const entry = { phase, chatId, admitted };
    report.phases.push(entry);
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
        fixture.server.origin,
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
      entry.restart = await fixture.restart({ crash: true });
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
        loadStoredWorkerCredential(dataDirectory, fixture.server.origin),
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
        `single server ${phase} SIGKILL preserves the same worker, original native model stream and live subscriptions`,
      );
    } catch (error) {
      entry.failure = { message: error.message, stack: error.stack };
      throw error;
    } finally {
      reply.release();
    }
  };
}
