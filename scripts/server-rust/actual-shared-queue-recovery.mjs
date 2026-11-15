// A real worker reconnects to its replacement server before draining the
// retained queue, optionally racing a browser-side claim at Resume.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { eventually } from "./full-worker.mjs";
import {
  interruptSharedQueue,
  verifyRecoveredQueueClaim,
} from "./actual-shared-queue-interruption.mjs";

export async function actualSharedQueueRecovery({
  page,
  fixture,
  worker,
  workerId,
  projectId,
  retainedChatId,
  retainedThreadId,
  resumeRaceFile,
  interruption,
  configuration,
  model,
  result,
  requests,
}) {
  const progress = (result.sharedQueueRecovery = { phase: "preparing" });
  let chatId = retainedChatId;
  if (!chatId) {
    chatId = await page.evaluate(async (projectId) => {
      const { prepareConversationCreation } =
        await import("/src/lib/api/conversations.ts");
      const create = await prepareConversationCreation(
        projectId,
        "Shared queue recovery",
        false,
      );
      const created = await create();
      window.folderLive.retainScope({ kind: "chat", chatId: created.id });
      return created.id;
    }, projectId);
    await eventually(
      () =>
        page.evaluate(
          async (id) =>
            (await import("/src/lib/api-client.ts")).request(
              `/api/chats/${id}/preparation`,
            ),
          chatId,
        ),
      (state) => assert.equal(state.preparation?.phase, "ready"),
    );
  }
  const readMessages = () =>
    page.evaluate(
      async (id) => (await import("/src/lib/api/chats.ts")).getMessages(id),
      chatId,
    );
  const queue = () =>
    page.evaluate(
      async (id) =>
        (await import("/src/lib/api/queue.ts")).getQueuedPromptState(id),
      chatId,
    );
  const pause = (paused) =>
    page.evaluate(
      async ({ id, paused }) =>
        (await import("/src/lib/api/chats.ts")).setChatPaused(id, paused),
      { id: chatId, paused },
    );
  const submit = (prompt) =>
    page.evaluate(
      async ({ chatId, prompt, configuration }) =>
        (await import("/src/lib/api/chats.ts")).startTurn(
          chatId,
          prompt,
          configuration,
        ),
      { chatId, prompt, configuration },
    );
  const posts = () => model.requests.filter((r) => r.method === "POST");
  const baseline = posts().length;
  const before = await fixture.assertRemoteWorker(workerId);
  const browserPeer = fixture.server.child;
  const workerPid = worker.pid;
  Object.assign(progress, {
    phase: "admission",
    chatId,
    retainedChat: Boolean(retainedChatId),
  });
  const inputs = [
    {
      prompt: "Private first queued recovery message 🌱",
      answer: "Private first recovered response 🌿",
    },
    {
      prompt: "Private second queued recovery message 🌼",
      answer: "Private second recovered response 🌻",
    },
  ];

  assert.equal((await pause(true)).paused, true);
  const admitted = [];
  for (const { prompt } of inputs) {
    const receipt = await submit(prompt);
    assert.equal(receipt.status, "queued");
    assert.equal(receipt.prompt.text, prompt);
    admitted.push(receipt.prompt.id);
  }
  const retained = await queue();
  Object.assign(progress, { admitted, retainedRevision: retained.revision });
  assert.deepEqual(
    retained.items.map((p) => p.id),
    admitted,
  );
  assert.equal(posts().length, baseline);

  const replaceWorkerOwner = async (afterCrash) => {
    const kind = fixture.workerFixture.kind;
    const replacement = await fixture.replacePeer(1, kind, {
      crash: true,
      afterCrash,
    });
    progress.replacement = replacement;
    assert.notEqual(replacement.before.pid, replacement.after.pid);
    assert.equal(replacement.before.instanceId, before.instanceId);
    assert.equal(fixture.server.child, browserPeer);
    const after = await eventually(
      () => fixture.workerClaim(workerId),
      (claim) => {
        assert.equal(claim?.instanceId, replacement.after.instanceId);
        assert.ok(claim.connectionId);
        assert.notEqual(claim.connectionId, before.connectionId);
      },
    );
    assert.equal(worker.pid, workerPid);
    assert.equal(worker.exitCode, null);
    assert.equal(worker.signalCode, null);
    progress.newWorkerConnection = after.connectionId;
  };
  Object.assign(progress, {
    workerPid,
    oldWorkerConnection: before.connectionId,
  });
  if (!interruption) {
    progress.phase = "replacing-worker-owner";
    await replaceWorkerOwner();
    assert.deepEqual(await queue(), retained);
    assert.equal(posts().length, baseline);
    result.steps.push(
      "two paused prompts retain their exact queue state after worker-owner server loss and the original full worker reconnects",
    );
  }

  progress.phase = "draining";
  if (resumeRaceFile)
    inputs.push({
      prompt: "Private prompt queued during Resume 🍃",
      answer: "Private response queued during Resume 🍀",
    });
  const replies = inputs.map(({ answer }, index) =>
    model.reply({
      text: answer,
      hold: index === 0 && Boolean(resumeRaceFile || interruption === "stream"),
    }),
  );
  if (interruption) {
    const fault = (progress.interruption = { phase: interruption });
    await interruptSharedQueue({
      fixture,
      chatId,
      promptId: admitted[0],
      firstReply: replies[0],
      modelPosts: () => posts().length - baseline,
      resume: () =>
        page.evaluate(async (id) => {
          const { setChatPaused } = await import("/src/lib/api/chats.ts");
          const { CantripApiError } = await import("/src/lib/api-client.ts");
          try {
            const { paused } = await setChatPaused(id, false);
            return { paused };
          } catch (error) {
            if (!(error instanceof CantripApiError)) throw error;
            return { status: error.status, error: error.message };
          }
        }, chatId),
      replaceWorkerOwner,
      fault,
    });
    result.steps.push(
      `the original full worker reconnects after its server dies at the durable queue ${interruption} boundary`,
    );
  } else if (resumeRaceFile) {
    const readProbe = async (phase) => {
      try {
        return JSON.parse(await readFile(resumeRaceFile + "." + phase, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return null;
      }
    };
    await writeFile(resumeRaceFile + ".armed", chatId);
    const resuming = pause(false);
    void resuming.catch(() => {});
    try {
      const held = await eventually(
        () => readProbe("held"),
        (probe) => assert.ok(probe, "worker Resume did not attempt a start"),
        20_000,
      );
      progress.resumeRace = { held };
      assert.equal(held.id, admitted[0]);
      const added = await submit(inputs[2].prompt);
      assert.equal(added.status, "queued");
      assert.equal(added.prompt.text, inputs[2].prompt);
      progress.resumeRace.addedId = added.prompt.id;
      const started = await eventually(
        () => replies[0].request,
        (request) =>
          assert.ok(request, "the browser peer did not start the head"),
        15_000,
      );
      const firstInput = started.input.input.findLast(
        (item) => item.role === "user",
      );
      assert.ok(JSON.stringify(firstInput).includes(inputs[0].prompt));
      assert.equal(started.completed, false);
      progress.resumeRace.headInFlight = true;
      await writeFile(resumeRaceFile + ".release", "");
      const receipt = await eventually(
        () => readProbe("receipt"),
        (probe) => assert.ok(probe, "worker Resume did not receive a receipt"),
      );
      progress.resumeRace.receipt = receipt;
      assert.deepEqual(receipt, {
        httpStatus: 200,
        operationId: held.operationId,
        status: "rejected",
        rejectionCode: "queue-revision-conflict",
        hasClaim: false,
      });
    } finally {
      replies[0].release();
      await writeFile(resumeRaceFile + ".release", "");
    }
    assert.equal((await resuming).paused, false);
  } else {
    assert.equal((await pause(false)).paused, false);
  }
  const turns = [];
  for (const [index, { prompt, answer }] of inputs.entries()) {
    const item = await eventually(
      async () =>
        (await readMessages())
          .flatMap((message) => message.content)
          .filter((item) => item.type === "text" && item.text === answer),
      (matches) => {
        assert.equal(matches.length, 1);
        assert.equal(matches[0].streaming, false);
        assert.equal(matches[0].correlation?.sourceMethod, "native-history");
        assert.ok(matches[0].correlation?.turnId);
        assert.ok(matches[0].correlation?.threadId);
      },
    );
    const request = posts()[baseline + index];
    assert.equal(request, replies[index].request);
    assert.equal(request.completed, true);
    const lastUserInput = request.input.input.findLast(
      (entry) => entry.role === "user",
    );
    assert.ok(JSON.stringify(lastUserInput).includes(prompt));
    const { turnId, threadId } = item[0].correlation;
    if (retainedThreadId) assert.equal(threadId, retainedThreadId);
    turns.push({ turnId, threadId });
  }
  assert.equal(new Set(turns.map(({ turnId }) => turnId)).size, inputs.length);
  await eventually(
    () =>
      page.evaluate(
        async (id) => (await import("/src/lib/api/chats.ts")).getChats(id),
        projectId,
      ),
    (chats) =>
      assert.equal(chats.find((item) => item.id === chatId)?.status, "idle"),
  );
  await eventually(queue, (state) => assert.deepEqual(state.items, []));
  await eventually(
    () =>
      page.evaluate(
        async ({ chatId, turns }) =>
          (await import("/src/lib/api-client.ts")).request(
            `/api/chats/${chatId}/native-history/turns/read`,
            { method: "POST", body: JSON.stringify({ turns }) },
          ),
        { chatId, turns },
      ),
    (archive) => {
      assert.equal(archive.turns.length, turns.length);
      assert.ok(
        archive.turns.every((entry) => entry.turn.status === "completed"),
      );
    },
  );
  assert.equal(posts().length, baseline + inputs.length);
  assert.deepEqual(model.failures, []);
  for (const marker of inputs.flatMap(({ prompt, answer }) => [
    prompt,
    answer,
  ])) {
    assert.equal(JSON.stringify(requests).includes(marker), false);
    assert.equal(
      fixture.peers.some((peer) => peer.server.diagnostics().includes(marker)),
      false,
    );
  }
  if (progress.interruption)
    await verifyRecoveredQueueClaim({
      fixture,
      chatId,
      promptId: admitted[0],
      turnId: turns[0].turnId,
      fault: progress.interruption,
    });
  Object.assign(progress, {
    phase: "passed",
    canonicalTurns: turns,
    newModelPosts: inputs.length,
  });
  result.steps.push(
    `unpausing the recovered queue executes all ${inputs.length} prompts in order, once each, and archives their native turns`,
  );
}
