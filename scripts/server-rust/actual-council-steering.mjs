// Browser SDK, native server, full worker, and bundled Codex App Server.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { actualCouncilAutomations } from "./actual-council-automations.mjs";
import { actualCouncilBrowserHistory } from "./actual-council-browser-history.mjs";
import { actualCouncilCompaction } from "./actual-council-compaction.mjs";
import { actualCouncilMemory } from "./actual-council-memory.mjs";
import { actualCouncilHistory } from "./actual-council-history.mjs";
import { actualCouncilInventory } from "./actual-council-inventory.mjs";
import { actualCouncilPeers } from "./actual-council-peers.mjs";
import { eventually } from "./full-worker.mjs";
import { modelFunctions, taskModelProvider } from "./task-model-provider.mjs";

export const councilSteeringFollowUp = "Steer the same Council turn 🍄";

async function readSteerRace(marker) {
  const trace = await readFile(marker, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return trace.trim().split("\n").filter(Boolean).map(JSON.parse);
}

export async function actualCouncilSteering({
  page,
  workerId,
  result,
  testCreation = false,
  memoryAppOrigin,
  historyFixture,
  inventory,
  peerAppOrigin,
  browserHistory,
  automations,
  compaction,
  raceMarker,
  dropReplyMarker,
}) {
  const model = await taskModelProvider({ observeStreams: true });
  const role = "Preserve this Council role marker 🌲";
  const original = "Read the durable Council queue";
  const followUp = councilSteeringFollowUp;
  const firstAnswer = "The first Council inference is active";
  const answer = "The Council steer reached the active turn";
  const timeout = 60_000;
  try {
    const { chatId, configuration } = await page.evaluate(
      async ({
        workerId,
        baseUrl,
        nativeModel,
        role,
        testCreation,
        readOnly,
        nativeCli,
      }) => {
        const models = await import("/src/lib/api/models.ts");
        const provider = await models.createModelProvider({
          name: "Disposable Council provider",
          kind: "openai-compatible",
          baseUrl,
          apiKey: null,
        });
        const profile = await models.createModelProfile({
          name: "Disposable Council model",
          routes: [
            { providerId: provider.id, modelName: nativeModel, enabled: true },
          ],
        });
        await (
          await import("/src/lib/api/settings.ts")
        ).updateSettings({
          defaultCouncilModelId: profile.id,
          autoNameChats: false,
          ...(readOnly
            ? { defaultCouncilPermissionProfileId: ":read-only" }
            : {}),
          ...(nativeCli ? { defaultCouncilPermissionProfileId: ":yolo" } : {}),
        });
        const workers = await (
          await import("/src/lib/api/worker-wire.ts")
        ).getWorkers();
        await (
          await import("/src/lib/chat-worker-encryption.ts")
        ).ensureChatWorkerEncryption({
          worker: workers.find((worker) => worker.workerId === workerId),
        });
        if (testCreation || nativeCli) {
          await (
            await import("/src/lib/private-label-worker-encryption.ts")
          ).ensurePrivateLabelWorkerEncryption({
            worker: workers.find((worker) => worker.workerId === workerId),
          });
        }
        const agent = await (
          await import("/src/lib/api/council.ts")
        ).createCouncilAgent("Disposable Operations Agent", role);
        window.folderLive.retainScope({ kind: "chat", chatId: agent.id });
        return {
          chatId: agent.id,
          configuration: {
            modelId: profile.id,
            reasoningEffort: null,
            customSubagentModel: false,
            subagentModelId: null,
            subagentReasoningEffort: null,
          },
        };
      },
      {
        workerId,
        baseUrl: model.baseUrl,
        nativeModel: model.model,
        role,
        testCreation,
        readOnly: Boolean(memoryAppOrigin || automations) && !testCreation,
        nativeCli: Boolean(inventory || peerAppOrigin),
      },
    );
    await eventually(
      () =>
        page.evaluate(
          (id) =>
            window
              .folderRequest("/api/council/agents")
              .then((agents) => agents.find((agent) => agent.id === id)),
          chatId,
        ),
      (agent) => {
        assert.equal(agent.primary, true);
        assert.equal(agent.scratchStatus, "ready");
      },
      timeout,
    );

    const submit = (text) =>
      page.evaluate(
        async ({ chatId, configuration, text }) =>
          (await import("/src/lib/api/chats.ts")).startTurn(
            chatId,
            text,
            configuration,
          ),
        { chatId, configuration, text },
      );
    const readQueue = () =>
      page.evaluate(
        (id) => window.folderRequest(`/api/chats/${id}/queue`),
        chatId,
      );
    const readMessages = () =>
      page.evaluate(
        async (id) => (await import("/src/lib/api/chats.ts")).getMessages(id),
        chatId,
      );
    const readChat = () =>
      page.evaluate(
        async (id) =>
          (await import("/src/lib/api/council.ts")).getCouncilChat(id),
        chatId,
      );
    const withText = (messages, text) =>
      messages.filter((message) =>
        message.content.some(
          (item) => item.type === "text" && item.text === text,
        ),
      );
    const held = model.reply({ hold: true, text: firstAnswer });
    model.reply({ text: answer });
    const first = await submit(original);
    assert.equal(first.status, "queued");
    await eventually(
      () => held.entered,
      (entered) => assert.equal(entered, true),
      timeout,
    );
    assert.ok(
      JSON.stringify(held.request.input).includes(role),
      "Codex received the browser-encrypted role",
    );
    assert.ok(
      JSON.stringify(held.request.input).includes("primary Council agent"),
      "Codex received the primary instruction",
    );

    const second = await submit(followUp);
    assert.equal(second.status, "queued");
    if (dropReplyMarker) {
      const [steer, dropped] = await eventually(
        () => readSteerRace(dropReplyMarker),
        (trace) => assert.equal(trace[1]?.phase, "dropped"),
        timeout,
      );
      assert.equal(steer.phase, "turn/steer");
      assert.match(steer.clientId, /^cantrip:/u);
      assert.ok(steer.turnId);
      assert.deepEqual(dropped, { phase: "dropped", turnId: steer.turnId });
      held.release();
      const messages = await eventually(
        readMessages,
        (messages) => {
          assert.equal(withText(messages, followUp).length, 1);
          assert.equal(withText(messages, answer).length, 1);
        },
        150_000, // The worker's normal App Server RPC deadline is 120 seconds.
      );
      const [root] = withText(messages, original);
      const [recovered] = withText(messages, followUp);
      assert.ok(root.executionLaneId);
      assert.equal(recovered.executionLaneId, root.executionLaneId);
      await eventually(readChat, (chat) => assert.equal(chat.status, "idle"));
      const queue = await readQueue();
      assert.deepEqual(queue.items, []);
      assert.deepEqual(queue.claims, []);
      const trace = await readSteerRace(dropReplyMarker);
      assert.equal(trace.length, 4);
      assert.deepEqual(trace[2], {
        phase: "thread/items/list",
        turnId: steer.turnId,
      });
      assert.equal(trace[3].phase, "history");
      const inputs = trace[3].inputs.filter(
        (item) => item.clientId === steer.clientId,
      );
      assert.equal(inputs.length, 1);
      assert.ok(inputs[0].id);
      assert.equal(
        model.requests.filter(({ method }) => method === "POST").length,
        2,
      );
      assert.deepEqual(model.failures, []);
      result.councilSteeringDroppedReply = { chatId, trace };
      result.steps.push(
        "Council reconciled a lost steer acknowledgement from the exact native user item without replaying it",
      );
      return;
    }
    if (raceMarker) {
      const [intercept] = await eventually(
        () => readSteerRace(raceMarker),
        ([intercept]) => {
          assert.equal(intercept?.phase, "held");
          assert.ok(intercept.turnId);
          assert.match(intercept.clientId, /^cantrip:/u);
          assert.equal(held.request.completed, false);
        },
        timeout,
      );
      held.release();
      const rejection = await eventually(
        () => readSteerRace(raceMarker),
        (trace) => assert.equal(trace[2]?.phase, "answered"),
        timeout,
      );
      assert.deepEqual(rejection.slice(0, 3), [
        intercept,
        { phase: "completed", turnId: intercept.turnId },
        {
          phase: "answered",
          error: { code: -32600, message: "no active turn to steer" },
        },
      ]);
      const messages = await eventually(
        readMessages,
        (messages) => assert.equal(withText(messages, answer).length, 1),
        timeout,
      );
      const [root] = withText(messages, original);
      const [retried] = withText(messages, followUp);
      assert.equal(withText(messages, original).length, 1);
      assert.equal(withText(messages, firstAnswer).length, 1);
      assert.equal(withText(messages, followUp).length, 1);
      assert.ok(root.executionLaneId && retried.executionLaneId);
      await eventually(readChat, (chat) => assert.equal(chat.status, "idle"));
      const queue = await readQueue();
      assert.deepEqual(queue.items, []);
      assert.deepEqual(queue.claims, []);
      const inferences = model.requests.filter(
        ({ method }) => method === "POST",
      );
      assert.equal(inferences.length, 2);
      assert.ok(!JSON.stringify(inferences[0].input).includes(followUp));
      assert.ok(JSON.stringify(inferences[1].input).includes(followUp));
      assert.deepEqual(model.failures, []);
      const trace = await readSteerRace(raceMarker);
      const recoveredTurnId = trace[4]?.turnId;
      assert.ok(recoveredTurnId);
      assert.notEqual(recoveredTurnId, intercept.turnId);
      assert.deepEqual(trace.slice(3), [
        { phase: "retried", clientId: intercept.clientId },
        { phase: "started", turnId: recoveredTurnId },
      ]);
      result.councilSteeringRace = {
        chatId,
        steeredPromptId: second.prompt.id,
        originalNativeTurnId: intercept.turnId,
        recoveredNativeTurnId: recoveredTurnId,
        trace,
      };
      result.steps.push(
        "The actual Codex App Server rejected a steer after completion, and Council started the prompt once in a new turn",
      );
      return;
    }
    const active = await eventually(
      readMessages,
      (messages) => {
        const [root] = withText(messages, original);
        const matches = withText(messages, followUp);
        assert.equal(matches.length, 1);
        assert.ok(root?.executionLaneId);
        assert.equal(matches[0].executionLaneId, root.executionLaneId);
        assert.equal(
          held.request.completed,
          false,
          "Steering finished while the first inference was active",
        );
      },
      timeout,
    );
    const queue = await readQueue();
    assert.ok(!queue.items.some((item) => item.id === second.prompt.id));
    assert.ok(
      !queue.claims.some((claim) => claim.promptId === second.prompt.id),
    );
    held.release();

    const messages = await eventually(
      readMessages,
      (messages) => {
        assert.equal(withText(messages, followUp).length, 1);
        assert.equal(withText(messages, answer).length, 1);
      },
      timeout,
    );
    const requests = model.requests.filter(({ method }) => method === "POST");
    assert.ok(
      requests.some(({ input }) => JSON.stringify(input).includes(followUp)),
    );
    assert.deepEqual(model.failures, []);
    result.councilSteering = {
      chatId,
      firstPromptId: first.prompt.id,
      steeredPromptId: second.prompt.id,
      executionLaneId: withText(active, followUp)[0].executionLaneId,
      messageCount: messages.length,
    };
    result.steps.push(
      "Council steers an active native turn through its durable queue",
    );
    if (automations) {
      await actualCouncilAutomations({
        ...automations,
        page,
        chatId,
        workerId,
        model,
        submit,
        readChat,
        readMessages,
        result,
      });
    }
    if (historyFixture) {
      await actualCouncilHistory({
        fixture: historyFixture,
        chatId,
        model,
        tools: modelFunctions(held.request.input.tools),
        submit,
        readChat,
        readMessages,
        result,
      });
    }
    if (inventory) {
      await actualCouncilInventory({
        ...inventory,
        page,
        chatId,
        workerId,
        model,
        tools: modelFunctions(held.request.input.tools),
        submit,
        readChat,
        result,
      });
    }
    if (peerAppOrigin) {
      await actualCouncilPeers({
        page,
        chatId,
        configuration,
        appOrigin: peerAppOrigin,
        model,
        tools: modelFunctions(held.request.input.tools),
        submit,
        readChat,
        readMessages,
        result,
      });
    }
    if (memoryAppOrigin) {
      await actualCouncilMemory({
        page,
        appOrigin: memoryAppOrigin,
        chatId,
        model,
        tools: modelFunctions(held.request.input.tools),
        submit,
        readChat,
        readMessages,
        result,
      });
    }
    if (browserHistory) {
      await eventually(
        readChat,
        (chat) => assert.equal(chat.status, "idle"),
        timeout,
      );
      const [source] = withText(messages, original);
      await actualCouncilBrowserHistory({
        ...browserHistory,
        page,
        chatId,
        workerId,
        source: { id: source.id, text: original },
        nearby: followUp,
        result,
      });
    }
    if (compaction) {
      const [source] = withText(messages, original);
      await actualCouncilCompaction({
        ...compaction,
        page,
        chatId,
        model,
        submit,
        readChat,
        readMessages,
        source: { id: source.id, text: original },
        previousAnswer: answer,
        result,
      });
    }
    if (testCreation) {
      const tools = modelFunctions(held.request.input.tools);
      const create = tools.find(
        ({ name }) =>
          name === "council_create" || name.endsWith("__council_create"),
      );
      assert.ok(
        create,
        "The actual Council provider exposes its managed create tool",
      );
      const title = "Maintenance Agent";
      const role = "Verify maintenance notes and summarize the checks.";
      await eventually(
        readChat,
        (chat) => assert.equal(chat.status, "idle"),
        timeout,
      );
      model.reply({ calls: [{ ...create, arguments: { title, role } }] });
      const completed = model.reply({
        text: "The maintenance agent is ready.",
      });
      assert.equal(
        (await submit("Create the maintenance agent now")).status,
        "queued",
      );
      const toolState = await eventually(
        async () => {
          if (completed.entered) return { completed: true, pending: [] };
          return page.evaluate(async (id) => {
            const api = await import("/src/lib/api/chats.ts");
            const chat = await (
              await import("/src/lib/api/council.ts")
            ).getCouncilChat(id);
            return {
              completed: false,
              status: chat.status,
              pending: await api.getAgentInteractionRequests({
                chatId: id,
                status: "pending",
              }),
            };
          }, chatId);
        },
        (state) =>
          assert.ok(
            state.completed || state.pending.length > 0,
            JSON.stringify({
              status: state.status,
              modelPostCount: model.requests.filter(
                ({ method }) => method === "POST",
              ).length,
              modelFailures: model.failures,
            }),
          ),
        timeout,
      );
      if (toolState.pending.length > 0) {
        const [pending] = toolState.pending;
        assert.equal(pending.payload.kind, "mcpElicitation");
        assert.equal(pending.payload.serverName, "cantrip");
        await page.evaluate(async (id) => {
          await (
            await import("/src/lib/api/chats.ts")
          ).respondToAgentInteractionRequest(id, {
            idempotencyKey: crypto.randomUUID(),
            response: {
              kind: "mcpElicitation",
              action: "accept",
              content: {},
              metadata: null,
            },
          });
        }, pending.id);
        await eventually(
          () => completed.entered,
          (entered) => assert.equal(entered, true),
          timeout,
        );
      }
      const agents = await page.evaluate(async () => {
        const api = await import("/src/lib/api/council.ts");
        return Promise.all(
          (await api.listCouncilAgents()).map(async (agent) => ({
            id: agent.id,
            title: agent.title,
            primary: agent.primary,
            role: await api.openCouncilRole(agent),
          })),
        );
      });
      const created = agents.filter((agent) => agent.title === title);
      assert.equal(created.length, 1);
      assert.equal(created[0].role, role);
      assert.equal(created[0].primary, false);
      assert.notEqual(created[0].id, chatId);
      result.councilAgentCreatedByPrompt = created[0].id;
      result.steps.push(
        "Council creates a fresh encrypted agent through the native managed MCP tool",
      );
    }
  } finally {
    await model.close();
  }
}
