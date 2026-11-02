import { threadChangeCases } from "./thread-change-reconciler-fixture.mjs";
import { threadSyncProjectionCases } from "./chat-thread-sync-fixtures.mjs";
import assert from "node:assert/strict";
import { command } from "./native-command-admission-cases.mjs";
import { otherOwner } from "./project-target-state.mjs";

export async function runThreadObservationCases(h) {
  const { reset, seed, observe, snapshot, reopen } = h;
  for (const scenario of threadChangeCases())
    await observe(scenario.name, scenario, {
      op: "native-command-thread-changes",
      shape: "raw",
    });
  for (const [index, fixture] of threadSyncProjectionCases().entries())
    await observe(
      "canonical projection " + index,
      {
        input: fixture.sync,
        options: fixture.options,
        attachments: fixture.attachments,
      },
      { op: "native-command-thread-sync-project", shape: "raw" },
    );
  const read = (name) =>
    observe(
      name,
      { chat: "chat" },
      { op: "native-command-context", shape: "raw" },
    );
  const reconcile = (name, contexts, status, options = {}) =>
    observe(name, (i) => ({ expected: contexts[i], status }), {
      op: "native-command-observe-thread",
      shape: "raw",
      ...options,
    });
  const prepare = async () => {
    await reset();
    await seed(
      "INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id) VALUES('observed-runtime','chat','alpha','github-alpha-main','observed-thread')",
    );
  };
  await prepare();
  let current = await read("original passive console binding");
  for (const status of ["idle", "failed", "idle"]) {
    const result = await reconcile(
      "passive status without a lane " + status,
      current,
      status,
    );
    for (const r of result) assert.equal(r.applied, true);
    current = await read("stored passive " + status);
    for (const c of current) assert.equal(c.status, status);
  }
  const idle = current;
  const running = await reconcile(
    "console starts an actual linked execution lane",
    idle,
    "running",
  );
  for (const r of running) {
    assert.equal(r.applied, true);
    assert.ok(r.execution.executionLaneId);
    assert.equal(r.execution.status, "running");
  }
  current = await read("read linked active lane");
  let before = await snapshot("linked console active");
  const stale = await reconcile(
    "stale idle binding cannot finish successor lane",
    idle,
    "failed",
  );
  for (const r of stale) assert.equal(r.applied, false);
  assert.deepEqual(
    await snapshot("stale passive observation commits nothing"),
    before,
  );
  const ended = await reconcile(
    "console completion suspends its exact lane",
    current,
    "idle",
  );
  for (const [i, r] of ended.entries()) {
    assert.equal(r.applied, true);
    assert.equal(r.execution.executionLaneId, current[i].executionLaneId);
  }
  current = await read("completed console owns no active lane");
  for (const c of current) {
    assert.equal(c.status, "idle");
    assert.equal(c.executionLaneId, null);
  }
  await reopen("passive console completion survives repository restart");

  for (const phase of [
    "before-admission",
    "during-preparation",
    "after-dispatch",
  ]) {
    for (const status of ["idle", "running", "failed"]) {
      await prepare();
      const initial = await read(`${phase} ${status} prior binding`);
      const input = command({
        operationId: "observed-gui",
        session: { threadId: "observed-thread" },
      });
      const admitted = await observe(
        `${phase} ${status} admits GUI start`,
        input,
      );
      const admittedContext = await read(`${phase} ${status} admitted binding`);
      const dispatchInput = (i) => ({
        workerId: "alpha",
        operationId: input.operationId,
        operationGeneration: admitted[i].receipt.operationGeneration,
        payloadDigest: input.payloadDigest,
        session: {
          ...input.session,
          runtimeGeneration: "observed-generation",
          connectionId: "observed-gui-connection",
        },
      });
      const dispatch = () =>
        observe(
          `${phase} ${status} retained send is dispatchable`,
          dispatchInput,
          { op: "native-command-dispatch", status: "dispatched" },
        );
      if (phase !== "before-admission") {
        const prepared = await observe(
          `${phase} ${status} binds actual GUI preparation`,
          (i) => ({ input: dispatchInput(i) }),
          { op: "native-command-bind-preparation", shape: "raw" },
        );
        for (const receipt of prepared)
          assert.equal(receipt.status, "accepted");
      }
      if (phase === "after-dispatch") await dispatch();
      const expected = phase === "before-admission" ? initial : admittedContext;
      before = await snapshot(`${phase} ${status} before passive read`);
      const result = await reconcile(
        `${phase} ${status} cannot retire admitted execution`,
        expected,
        status,
      );
      for (const r of result) assert.equal(r.applied, false);
      assert.deepEqual(
        await snapshot(`${phase} ${status} preserves activation and lane`),
        before,
      );
      if (phase !== "after-dispatch") {
        const dispatched = await dispatch();
        for (const r of dispatched)
          assert.equal(r.receipt.status, "dispatched");
      }
    }
  }
  await prepare();
  current = await read("binding for stale placement guards");
  for (const field of [
    "contextKind",
    "workerId",
    "worktreeId",
    "threadId",
    "modelRouteId",
    "providerAccountId",
    "executionLaneId",
  ]) {
    const expected = current.map((c) => ({ ...c, [field]: "stale-" + field }));
    before = await snapshot("before stale " + field);
    const result = await reconcile(
      "stale " + field + " cannot relabel current Chat",
      expected,
      "failed",
    );
    for (const r of result) assert.equal(r.applied, false);
    assert.deepEqual(await snapshot("after stale " + field), before);
  }
  before = await snapshot("before foreign observation");
  await reconcile(
    "foreign owner cannot observe another Chat",
    current,
    "running",
    { requestOwner: otherOwner, error: true, code: "chat-not-found" },
  );
  assert.deepEqual(
    await snapshot("foreign observation creates no lane or state"),
    before,
  );
}
