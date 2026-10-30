import assert from "node:assert/strict";
import { runDisconnectCase } from "./run-disconnect-http-case.mjs";
import { eventually } from "./full-worker.mjs";
import { fileDocumentWireFixtures } from "./file-document-wire-fixtures.mjs";
export { runDefinition } from "./run-definition-fixture.mjs";
export async function runLifecycleCases({
  visit,
  fixture,
  worker,
  projectId,
  worktreeId,
  setMode,
  groupConcurrent,
}) {
  let index = 0;
  const configurationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const operationId = () =>
    `dddddddd-dddd-4ddd-8ddd-${String(++index).padStart(12, "0")}`;
  const input = (operation) => ({
    operationId: operationId(),
    projectId,
    configurationId,
    targetWorktreeId: worktreeId,
    operation,
  });
  const send = (label, json, status = 200) =>
    visit(label, "POST", "/api/run-configuration-runtimes/operations", {
      json,
      status,
    });
  await send("Run lifecycle invalid body", {}, 400);
  await send(
    "Run lifecycle missing target",
    {
      ...input("start"),
      targetWorktreeId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    },
    404,
  );
  setMode("active");
  const start = input("start"),
    started = await send("Run lifecycle start", start, 202);
  assert.equal(started.runtime.state, "running");
  assert.equal(started.runtime.generation, 1);
  assert.equal(started.replayed, false);
  const command = worker.runtimeCommands.findLast((command) =>
    command.type.endsWith(".start"),
  );
  const protectedValue =
    fileDocumentWireFixtures().fileDocumentCreateSchema[0].stateProtection
      .protectedState;
  assert.deepEqual(command.protectedSecrets, [
    { reference: "run/api", revision: 2, protectedValue },
    { reference: "run/platform", revision: 3, protectedValue },
  ]);
  const commands = worker.runtimeCommands.length;
  const replay = await send("Run lifecycle replay start", start);
  assert.equal(replay.replayed, true);
  assert.equal(replay.runtime.id, started.runtime.id);
  assert.equal(
    worker.runtimeCommands.length,
    commands,
    "replay avoids worker dispatch and definition fetch",
  );
  await send(
    "Run lifecycle conflicting replay",
    { ...start, operation: "stop" },
    409,
  );
  const running = await send("Run lifecycle already running", input("start"));
  assert.equal(running.operation.outcome, "already-active");
  const restarted = await send("Run lifecycle restart", input("restart"), 202);
  assert.equal(restarted.runtime.generation, 2);
  assert.equal(restarted.runtime.terminalId, started.runtime.terminalId);
  setMode("exited");
  const stopped = await send("Run lifecycle stop", input("stop"), 202);
  assert.equal(stopped.runtime.state, "exited");
  const current = await send(
    "Run lifecycle old receipt current runtime",
    start,
  );
  assert.equal(current.runtime.state, "exited");
  assert.equal(current.runtime.generation, 2);
  assert.equal(current.operation.generation, 1);
  const idle = await send("Run lifecycle already stopped", input("stop"));
  assert.equal(idle.operation.outcome, "not-active");
  setMode("not-found");
  await send("Run lifecycle worker missing", input("start"), 409);
  const status = await visit(
    "Run lifecycle failure persisted",
    "POST",
    "/api/run-configuration-runtimes/status",
    {
      json: {
        operationId: operationId(),
        projectId,
        configurationId,
        targetWorktreeId: worktreeId,
      },
    },
  );
  assert.equal(status.runtimes[0].state, "failed");
  assert.equal(status.runtimes[0].failure.code, "worker-runtime-not-found");
  await groupConcurrent("Run concurrent group", async () => {
    const concurrentStart = input("start");
    const concurrentStop = input("stop");
    let release;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    let reached = false;
    worker.beforeRuntimeResponse = async (command) => {
      if (
        command.type.endsWith(".start") &&
        command.identity.operationId === concurrentStart.operationId
      ) {
        reached = true;
        await barrier;
        setMode("active");
      } else if (
        command.type.endsWith(".stop") &&
        command.identity.operationId === concurrentStop.operationId
      ) {
        setMode("exited");
      }
    };
    const startCount = worker.runtimeCommands.filter((command) =>
      command.type.endsWith(".start"),
    ).length;
    const first = send("Run concurrent admitted start", concurrentStart, 202);
    // Attach rejection handling immediately while the dispatch barrier is held.
    first.catch(() => {});
    try {
      await eventually(
        () => reached,
        (value) => assert.equal(value, true),
      );
      const inFlight = await visit(
        "Run concurrent committed admission",
        "POST",
        "/api/run-configuration-runtimes/status",
        {
          json: {
            operationId: operationId(),
            projectId,
            configurationId,
            targetWorktreeId: worktreeId,
          },
        },
      );
      assert.equal(inFlight.runtimes[0].state, "starting");
      assert.equal(
        inFlight.runtimes[0].requestedOperationId,
        concurrentStart.operationId,
      );
      const duplicate = send("Run concurrent replay", concurrentStart);
      release();
      const [admitted, replayed] = await Promise.all([first, duplicate]);
      // Read the receipt before a different operation legitimately changes
      // its current runtime snapshot; this keeps the comparison deterministic.
      const stopped = await send(
        "Run after concurrent replay stop",
        concurrentStop,
        202,
      );
      assert.equal(admitted.runtime.state, "running");
      assert.equal(admitted.operation.id, concurrentStart.operationId);
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.operation.id, concurrentStart.operationId);
      assert.equal(stopped.runtime.state, "exited");
      assert.equal(stopped.runtime.generation, admitted.runtime.generation);
      assert.equal(
        worker.runtimeCommands.filter((command) =>
          command.type.endsWith(".start"),
        ).length,
        startCount + 1,
      );
    } finally {
      release();
      delete worker.beforeRuntimeResponse;
    }
  });
  let disconnected;
  await groupConcurrent("Run disconnected group", async () => {
    disconnected = await runDisconnectCase({
      fixture,
      worker,
      input,
      send,
      setMode,
    });
  });
  setMode("exited");
  assert.ok(fixture.records.has("Run lifecycle restart"));
  return { disconnected };
}
