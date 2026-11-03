// Existing browser automation SDK -> normal server -> full production worker
// scheduler/condition executor -> actual bundled native runtime. Only model HTTP
// output is controlled. No SQL clock manipulation or substitute worker commands.
import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";

export async function actualProjectAutomationsClient({
  page,
  fixture,
  projectId,
  chatId,
  workerId,
  startWorker,
  stopWorker,
  model,
  result,
  requests,
}) {
  const markers = {
    name: "Private actual automation name 🕰",
    prompt: "Private actual automation prompt 🔮",
    answer: "Private actual automation answer ✨",
    skipped: "Private actual skipped automation 💤",
  };
  const baseline = model.requests.filter((r) => r.method === "POST").length;
  const created = await page.evaluate(
    async ({ projectId, chatId, markers }) => {
      const api = await import("/src/lib/project-automation-api.ts");
      const schedule = {
        kind: "interval",
        every: 1000000,
        unit: "minute",
        startsAt: "2040-01-01T00:00:00.000Z",
      };
      const started = await api.createProjectAutomation(projectId, {
        name: markers.name,
        chatId,
        prompt: markers.prompt,
        schedule,
        enabled: false,
        condition: { type: "script", script: "exit 0" },
      });
      const skipped = await api.createProjectAutomation(projectId, {
        name: markers.skipped,
        chatId,
        prompt: markers.prompt + " skipped",
        schedule,
        enabled: false,
        condition: { type: "script", script: "exit 7" },
      });
      return { started, skipped };
    },
    { projectId, chatId, markers },
  );
  assert.equal(created.started.name, markers.name);
  assert.equal(created.started.prompt, markers.prompt);
  assert.equal(created.started.enabled, false);
  assert.equal(created.started.nextRunAt, null);
  const read = () =>
    page.evaluate(
      async (projectId) =>
        (
          await import("/src/lib/project-automation-api.ts")
        ).getProjectAutomations(projectId),
      projectId,
    );
  const restart = async (afterStop) => {
    await stopWorker();
    const captured = await afterStop?.();
    const port = Number(new URL(fixture.server.origin).port);
    await fixture.close();
    await fixture.start({ port });
    await startWorker();
    await page.evaluate(async (workerId) => {
      const worker = (
        await (await import("/src/lib/api/worker-wire.ts")).getWorkers()
      ).find((w) => w.workerId === workerId);
      await (
        await import("/src/lib/chat-worker-encryption.ts")
      ).ensureChatWorkerEncryption({ worker });
    }, workerId);
    return captured;
  };
  const initial = await read();
  await restart();
  assert.deepEqual(
    await read(),
    initial,
    "disabled protected schedules survive server and full-worker restart exactly",
  );
  const nativeReply = model.reply({ text: markers.answer });
  const enabled = await page.evaluate(
    async ({ ids }) => {
      const api = await import("/src/lib/project-automation-api.ts");
      const schedule = {
        kind: "interval",
        every: 1000000,
        unit: "minute",
        startsAt: new Date(Date.now() + 5000).toISOString(),
      };
      return Promise.all(
        ids.map((id) =>
          api.updateProjectAutomation(id, { enabled: true, schedule }),
        ),
      );
    },
    { ids: [created.started.id, created.skipped.id] },
  );
  for (const a of enabled) {
    assert.equal(a.revision, 2);
    assert.equal(a.enabled, true);
    assert.equal(a.nextRunAt, a.schedule.startsAt);
  }
  const dispatched = await eventually(read, (automations) => {
    assert.equal(
      automations.find((a) => a.id === created.started.id)?.lastStatus,
      "started",
    );
    assert.equal(
      automations.find((a) => a.id === created.skipped.id)?.lastStatus,
      "skipped",
    );
  });
  const messages = () =>
    page.evaluate(
      async (chatId) =>
        (await import("/src/lib/api/chats.ts")).getMessages(chatId),
      chatId,
    );
  await eventually(messages, (items) =>
    assert.ok(
      items.some((message) =>
        message.content.some(
          (item) => item.type === "text" && item.text === markers.answer,
        ),
      ),
    ),
  );
  await eventually(
    () =>
      page.evaluate(
        async (projectId) =>
          (await import("/src/lib/api/chats.ts")).getChats(projectId),
        projectId,
      ),
    (chats) => assert.equal(chats.find((c) => c.id === chatId)?.status, "idle"),
  );
  const canonical = await eventually(messages, (items) => {
    const message = items.find((message) =>
      message.content.some(
        (item) => item.type === "text" && item.text === markers.answer,
      ),
    );
    const item = message?.content.find(
      (item) => item.type === "text" && item.text === markers.answer,
    );
    assert.equal(item?.correlation?.sourceMethod, "native-history");
    assert.equal(item.streaming, false);
  });
  const turn = canonical
    .flatMap((message) => message.content)
    .find(
      (item) => item.type === "text" && item.text === markers.answer,
    ).correlation;
  await eventually(
    () =>
      page.evaluate(
        async ({ chatId, turn }) =>
          (await import("/src/lib/api-client.ts")).request(
            `/api/chats/${chatId}/native-history/turns/read`,
            {
              method: "POST",
              body: JSON.stringify({
                turns: [{ threadId: turn.threadId, turnId: turn.turnId }],
              }),
            },
          ),
        { chatId, turn },
      ),
    (archive) => {
      assert.equal(archive.turns.length, 1);
      assert.equal(archive.turns[0].turn.status, "completed");
    },
  );
  assert.equal(nativeReply.request.completed, true);
  assert.equal(
    model.requests.filter((r) => r.method === "POST").length,
    baseline + 1,
    "only the permitted protected automation invokes inference",
  );
  await page.evaluate(
    async (ids) => {
      const api = await import("/src/lib/project-automation-api.ts");
      for (const id of ids)
        await api.updateProjectAutomation(id, { enabled: false });
    },
    [created.started.id, created.skipped.id],
  );
  const retained = await read();
  const committed = await restart(messages);
  assert.deepEqual(await read(), retained);
  assert.deepEqual(
    await messages(),
    committed,
    "automation canonical history survives restart exactly after graceful worker drain",
  );
  for (const a of dispatched) {
    assert.ok(a.nextRunAt);
    assert.equal(a.lastError, null);
  }
  await page.evaluate(
    async (ids) => {
      const api = await import("/src/lib/project-automation-api.ts");
      for (const id of ids) await api.deleteProjectAutomation(id);
    },
    [created.started.id, created.skipped.id],
  );
  assert.deepEqual(await read(), []);
  assert.equal(
    model.requests.filter((r) => r.method === "POST").length,
    baseline + 1,
  );
  for (const marker of Object.values(markers)) {
    assert.equal(
      JSON.stringify(requests).includes(marker),
      false,
      "automation plaintext stays out of browser-to-server requests",
    );
    assert.equal(
      fixture.server.diagnostics().includes(marker),
      false,
      "automation plaintext stays out of server diagnostics",
    );
  }
  assert.deepEqual(model.failures, []);
  result.projectAutomations = {
    completed: true,
    actualScheduler: true,
    actualScriptConditions: [0, 7],
    started: 1,
    skipped: 1,
    completedNativeTurns: 1,
    retainedAfterTwoRestarts: true,
    deleted: true,
    additionalModelRequests: 1,
  };
  result.steps.push(
    "existing encrypted automation SDK, real full-worker scheduler and actual script conditions admit one native turn and skip the other; protected state and canonical history survive two restarts before deletion",
  );
}
