// The existing client carries its real session, keys and App Live resume state
// through a replacement. The production worker process is never substituted.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadStoredWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { eventually } from "./full-worker.mjs";

export async function verifySharedProductRolling({
  fixture,
  page,
  projectId,
  workerId,
  directory,
  dataDirectory,
  worker,
  credential,
  result,
}) {
  const file = "private-rolling-" + crypto.randomUUID() + ".txt";
  const content = "Encrypted rolling resource 🍄\n".repeat(2048);
  await writeFile(path.join(directory, file), "Original rolling resource\n");
  await page.evaluate(async (workerId) => {
    const { ensureSurfacePrivateStateWorkerEncryption } =
      await import("/src/lib/surface-private-state-worker-encryption.ts");
    const worker = (await window.folderWorkers.getWorkers()).find(
      (worker) => worker.workerId === workerId,
    );
    await ensureSurfacePrivateStateWorkerEncryption({ worker });
  }, workerId);
  await page.evaluate(() => window.folderLive.start());
  const binding = await page.evaluate(
    async ({ projectId, workerId, file }) => {
      const { createExplorer } = await import("/src/lib/api/explorers.ts");
      const explorer = await createExplorer(
        projectId,
        "Private rolling Explorer",
        undefined,
        undefined,
        undefined,
        {
          attachToTabLayout: false,
          initialViewState: { selectedPath: file, fileMode: "edit" },
        },
      );
      return {
        explorerId: explorer.id,
        projectId,
        workerId,
        worktreeId: explorer.worktreeId,
      };
    },
    { projectId, workerId, file },
  );
  async function read() {
    return page.evaluate(
      async ({ binding, file }) => {
        const { getExplorerFile } = await import("/src/lib/api/files.ts");
        const { explorerId, ...location } = binding;
        return getExplorerFile(explorerId, file, location);
      },
      { binding, file },
    );
  }
  assert.equal((await read()).content, "Original rolling resource\n");
  const invalidBinding = await page.evaluate(
    async ({ binding, file }) => {
      const { getExplorerFile } = await import("/src/lib/api/files.ts");
      try {
        await getExplorerFile(binding.explorerId, file, binding);
        return { accepted: true };
      } catch (error) {
        return { status: error.status ?? null, message: error.message };
      }
    },
    { binding, file },
  );
  assert.deepEqual(invalidBinding, {
    status: 400,
    message: 'Invalid request body: binding: Unrecognized key: "explorerId"',
  });
  const chatIds = [
    ...new Set(
      [result.projectChatId, result.taskExecution?.chatId].filter(Boolean),
    ),
  ];
  const managedChatIds = result.projectChatId ? [result.projectChatId] : [];
  async function taskState() {
    if (!result.taskExecution?.chatId) return null;
    return page.evaluate(
      async (id) => (await import("/src/lib/api/tasks.ts")).getTask(id),
      result.taskExecution.chatId,
    );
  }
  async function canonical() {
    return page.evaluate(async (ids) => {
      const { getMessages } = await import("/src/lib/api/chats.ts");
      return Promise.all(
        ids.map(async (id) => ({ id, messages: await getMessages(id) })),
      );
    }, chatIds);
  }
  // Native live events and the durable projection intentionally have different
  // correlation/attribution fields. Observe the real committed turns and their
  // materialized message projection before taking an immutable baseline.
  const committed = await eventually(
    () =>
      page.evaluate(async (ids) => {
        const { getMessages } = await import("/src/lib/api/chats.ts");
        const { request } = await import("/src/lib/api-client.ts");
        return Promise.all(
          ids.map(async (id) => {
            const messages = await getMessages(id);
            const correlations = messages
              .filter((message) => message.role === "assistant")
              .flatMap((message) =>
                message.content.map(
                  (item) => item.correlation ?? item.activity?.correlation,
                ),
              )
              .filter(
                (correlation) => correlation?.threadId && correlation?.turnId,
              );
            const unique = new Map(
              correlations.map((c) => [
                c.threadId + ":" + c.turnId,
                { threadId: c.threadId, turnId: c.turnId },
              ]),
            );
            const turns = [...unique.values()];
            const archive = await request(
              `/api/chats/${id}/native-history/turns/read`,
              {
                method: "POST",
                body: JSON.stringify({ turns }),
              },
            );
            return {
              id,
              messages,
              correlations,
              requestedTurns: turns.length,
              requestedIdentities: turns,
              archivedTurns: archive.turns,
            };
          }),
        );
      }, managedChatIds),
    (rows) => {
      for (const row of rows) {
        assert.ok(
          row.requestedTurns > 0,
          "completed native conversation has real correlated turns",
        );
        const identity = (turn) => JSON.stringify([turn.threadId, turn.turnId]);
        assert.deepEqual(
          [
            ...new Set(row.archivedTurns.map(({ turn }) => identity(turn))),
          ].sort(),
          row.requestedIdentities.map(identity).sort(),
          "all observed native turns are durably archived, including binding-local candidates",
        );
        for (const { turn } of row.archivedTurns)
          assert.ok(
            ["completed", "failed", "interrupted"].includes(turn.status),
            "native turn must reach its actual terminal state",
          );
        // Native item/* events are replaced by native-history items. Worker
        // supplements (turn/completed agent communications and assembled
        // cantrip/trajectory instructions) retain their original methods.
        // Every supplement still participates in the exact snapshot below.
        assert.equal(
          row.correlations.some((c) => c.sourceMethod?.startsWith("item/")),
          false,
          "wait for native item events to materialize in the canonical projection",
        );
      }
    },
  );
  // Task operations use their durable Task message/receipt pipeline, rather
  // than the managed Agent's native-history bindings. Require the real Task
  // completion and preserve its entire DTO and messages through replacement.
  const completedTask = await taskState();
  if (completedTask) assert.equal(completedTask.state, "complete");
  const history = await canonical();
  for (const chat of history)
    assert.ok(
      chat.messages.length > 0,
      "completed native execution retains actual history",
    );
  const workerPid = worker.child.pid;
  const transitions = [];
  for (const index of [0, 1]) {
    const before = await fixture.assertRemoteWorker(workerId);
    const transition = await fixture.replacePeer(index);
    await eventually(
      () => fixture.workerClaim(workerId),
      (claim) => {
        assert.equal(
          claim?.instanceId,
          fixture.workerFixture.environment.CANTRIP_SERVER_INSTANCE_ID,
        );
        if (index === 0)
          assert.equal(
            claim.connectionId,
            before.connectionId,
            "replacing application peer keeps worker connection",
          );
        else
          assert.notEqual(
            claim.connectionId,
            before.connectionId,
            "replacing worker peer requires a new real connection generation",
          );
      },
    );
    await eventually(
      () => page.evaluate(() => window.folderLive.snapshot()),
      (snapshot) => assert.equal(snapshot.status, "live"),
    );
    const reads = [];
    const observed = await eventually(
      async () => {
        try {
          const value = await read();
          return { value };
        } catch (error) {
          const failure = { message: error.message };
          reads.push(failure);
          return { failure };
        }
      },
      (value) =>
        assert.equal(
          value.value?.content,
          index === 0 ? "Original rolling resource\n" : content,
        ),
    );
    const saved = await page.evaluate(
      async ({ binding, file, content, version }) => {
        const { saveExplorerFile } = await import("/src/lib/api/files.ts");
        const { explorerId, ...location } = binding;
        return saveExplorerFile(
          explorerId,
          { path: file, content, version },
          location,
        );
      },
      { binding, file, content, version: observed.value.version },
    );
    assert.equal(saved.content, content);
    assert.equal(await readFile(path.join(directory, file), "utf8"), content);
    assert.equal(worker.child.pid, workerPid);
    assert.equal(
      worker.child.exitCode,
      null,
      "the original full worker remains alive",
    );
    assert.equal(worker.child.signalCode, null);
    assert.deepEqual(
      loadStoredWorkerCredential(
        dataDirectory,
        fixture.workerFixture.server.origin,
      ),
      credential,
    );
    assert.deepEqual(
      await canonical(),
      history,
      "peer replacement preserves the exact completed canonical conversation",
    );
    assert.deepEqual(
      await taskState(),
      completedTask,
      "peer replacement preserves the exact completed Task state",
    );
    transitions.push({
      ...transition,
      workerPid,
      claim: await fixture.assertRemoteWorker(workerId),
      transientReads: reads,
    });
  }
  const requests = JSON.stringify(result.requests);
  assert.equal(
    requests.includes(file),
    false,
    "rolling file path stays opaque to the server",
  );
  assert.equal(
    requests.includes(content),
    false,
    "rolling file content stays opaque to the server",
  );
  result.sharedProductRolling = {
    invalidBinding,
    retainedChats: chatIds.length,
    committedTurns: committed.map((row) => ({
      chatId: row.id,
      turns: row.archivedTurns.length,
    })),
    completedTask: completedTask
      ? {
          state: completedTask.state,
          sha256: createHash("sha256")
            .update(JSON.stringify(completedTask))
            .digest("hex"),
        }
      : null,
    canonicalHistorySha256: createHash("sha256")
      .update(JSON.stringify(history))
      .digest("hex"),
    transitions,
    retainedWorkerPid: workerPid,
    encryptedFileBytes: Buffer.byteLength(content),
    actualFile: path.join(directory, file),
  };
  result.steps.push(
    "application peer replacement retains actual browser session, encryption, App Live and a live remote worker; encrypted file reads and writes succeed",
  );
  result.steps.push(
    "worker peer replacement reconnects the same full worker with its retained credential and a new fenced generation; real encrypted file operations recover",
  );
}
