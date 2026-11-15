// A real worker reconnects to its replacement server before draining the
// retained queue. Only the model's public HTTP responses are scripted.
import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";

export async function actualSharedQueueRecovery({
  page,
  fixture,
  worker,
  workerId,
  projectId,
  configuration,
  model,
  result,
  requests,
}) {
  const progress = (result.sharedQueueRecovery = { phase: "preparing" });
  const chatId = await page.evaluate(async (projectId) => {
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
  const posts = () => model.requests.filter((r) => r.method === "POST");
  const baseline = posts().length;
  const before = await fixture.assertRemoteWorker(workerId);
  const browserPeer = fixture.server.child;
  const workerPid = worker.pid;
  Object.assign(progress, { phase: "admission", chatId });
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
    const receipt = await page.evaluate(
      async ({ chatId, prompt, configuration }) =>
        (await import("/src/lib/api/chats.ts")).startTurn(
          chatId,
          prompt,
          configuration,
        ),
      { chatId, prompt, configuration },
    );
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

  progress.phase = "replacing-worker-owner";
  const kind = fixture.workerFixture.kind;
  const replacement = await fixture.replacePeer(1, kind, { crash: true });
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
  assert.deepEqual(await queue(), retained);
  assert.equal(posts().length, baseline);
  result.steps.push(
    "two paused prompts retain their exact queue state after worker-owner server loss and the original full worker reconnects",
  );

  progress.phase = "draining";
  const replies = inputs.map(({ answer }) => model.reply({ text: answer }));
  assert.equal((await pause(false)).paused, false);
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
    turns.push({ turnId, threadId });
  }
  assert.notEqual(turns[0].turnId, turns[1].turnId);
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
  Object.assign(progress, {
    phase: "passed",
    replacement,
    workerPid,
    oldWorkerConnection: before.connectionId,
    newWorkerConnection: after.connectionId,
    canonicalTurns: turns,
    newModelPosts: inputs.length,
  });
  result.steps.push(
    "unpausing the recovered queue executes the two prompts in order, once each, and archives both native turns",
  );
}
