// Stop a real server during dispatch, reopen its persistent store and reconnect
// the unchanged worker transport. Native Codex operations remain controlled.
import assert from "node:assert/strict";
import { LiveProbe } from "./live-sockets.mjs";
export async function exportShutdown({
  fixture: f,
  state,
  worker,
  live,
  visit,
  body,
  endpoint,
  sqlState,
  settled,
  reset,
  result,
  project,
  deferred,
}) {
  const before = await sqlState();
  const entered = deferred(),
    release = deferred();
  const input = body(["third", "second", "empty"]);
  const commandOffset = state.commands.length;
  state.intercept = async (command) => {
    if (
      command.type === "project.export.chat.begin" &&
      command.chatId === "second"
    ) {
      entered.resolve();
      await release.promise;
    }
  };
  const pending = visit("actual shutdown during export", "POST", endpoint, {
    json: input,
    timeoutMs: 45000,
  });
  pending.catch(() => {});
  let stopped;
  const previous = f.server;
  try {
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error("Export settled before controlled dispatch");
      }),
    ]);
    // The dispatched begin command retains its real 30-second deadline across
    // reconnect grace. Let that existing contract settle before the fixture's
    // outer shutdown bound; do not turn a 15-second fixture kill into a claim
    // that the Source server violated its own longer command deadline.
    worker.pauseHeartbeat();
    const shutdownStarted = Date.now();
    stopped = f.close({ shutdownTimeoutMs: 45000 });
    stopped.catch(() => {});
    const response = await pending;
    assert.equal(response.outcomes[0].status, "exported");
    assert.deepEqual(
      response.outcomes.slice(1).map((outcome) => outcome.status),
      ["failed", "failed"],
    );
    await stopped;
    assert.equal(previous.child.exitCode, 0);
    result.shutdown = {
      response,
      commands: state.commands.slice(commandOffset),
      exitCode: previous.child.exitCode,
      elapsedMs: Date.now() - shutdownStarted,
      events: previous.events,
      diagnostics: previous.diagnostics(),
    };
  } finally {
    release.resolve();
    await worker.close();
    if (stopped) await stopped;
    reset();
  }
  await live.waitClosed();
  await f.start({ port: Number(new URL(previous.origin).port) });
  await worker.start();
  const reopened = await new LiveProbe(f).open();
  await reopened.initialized();
  await reopened.subscribed("exports after real server restart", [
    { kind: "project", projectId: project },
  ]);
  assert.deepEqual(
    await sqlState(),
    before,
    "Actual restart retains every canonical SQL row after interrupted exports",
  );
  return {
    live: reopened,
    retry: async () => {
      const retried = await settled(
        "retry interrupted export after real restart",
        input,
      );
      assert.deepEqual(
        retried.outcomes.map((outcome) => outcome.status),
        ["exported", "exported", "exported"],
      );
      assert.equal(retried.outcomes[0].reused, true);
      result.shutdown.retry = retried;
    },
  };
}
