import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as crypto from "../../packages/crypto/dist/index.js";
import { modelFunctions } from "../server-rust/task-model-provider.mjs";
import { createPreparedProjectChat } from "./console-interaction-cases.mjs";

export async function verifySubagentInteraction({
  call,
  eventually,
  createModel,
  encryptedTurn,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  interactionKey,
  customModel = false,
}) {
  const childName = "cantrip-approval-child-model";
  const childEffort = "high";
  const { model, profile, provider } = await createModel(
    "Subagent approval model",
    3,
    customModel
      ? [
          {
            id: childName,
            capabilities: {
              trained_for_tool_use: true,
              reasoning: { allowed_options: ["medium", childEffort] },
            },
          },
        ]
      : [],
  );
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: profile.id,
    defaultChatPermissionProfileId: ":workspace",
    autoNameChats: false,
  });
  const { chatId, chatUrl } = await createPreparedProjectChat({
    call,
    eventually,
    ownerId,
    workerId,
    keyRevision,
    labelKey,
    title: "Subagent approval",
  });
  const configuration = (subagentModelId) => ({
    modelId: profile.id,
    reasoningEffort: null,
    customSubagentModel: true,
    subagentModelId,
    subagentReasoningEffort: childEffort,
  });
  const refreshSettings = () =>
    call("POST", `${chatUrl}/native-settings/refresh`, 200, {});
  let warm;
  let childConfiguration;
  if (customModel) {
    warm = await eventually(refreshSettings, ({ effective }) =>
      assert.ok(effective),
    );
    const route = `${chatUrl}/model-configuration`;
    const { profile: foreign } = await createModel("Unrelated provider");
    const incompatible = await call(
      "PATCH",
      route,
      409,
      configuration(foreign.id),
    );
    assert.equal(incompatible.code, "provider-route-incompatible");
    const catalog = await call(
      "POST",
      `/api/settings/providers/${provider.id}/catalog/refresh?workerId=${workerId}`,
      200,
      {},
    );
    assert.ok(
      catalog.models
        .find(({ nativeModelId }) => nativeModelId === childName)
        ?.supportedReasoningEfforts.some(
          ({ effort }) => effort === childEffort,
        ),
    );
    const childProfile = await call("POST", "/api/settings/models", 201, {
      name: "Custom child model",
      routes: [
        { providerId: provider.id, modelName: childName, enabled: true },
      ],
    });
    childConfiguration = configuration(childProfile.id);
    await call("PATCH", route, 200, childConfiguration);
  }
  const command = "printf cantrip-private-child-approval-fixture";
  const held = [];
  const hold = (responseId) => {
    const response = model.reply({ hold: true, responseId });
    held.push(response);
    return response;
  };
  const firstResponse = hold();
  const entered = (plan) =>
    eventually(
      () => plan.request,
      (request) => assert.ok(request),
    );
  const findTool = (tools, name) =>
    modelFunctions(tools).find(
      (candidate) =>
        candidate.name === name || candidate.name.endsWith(`__${name}`),
    );
  const tool = (tools, name) => {
    const entry = findTool(tools, name);
    assert.ok(entry, `Bundled Codex advertises ${name}`);
    return entry;
  };
  try {
    const payload = await encryptedTurn(
      "Delegate one local approval fixture.",
      profile.id,
    );
    if (childConfiguration)
      Object.assign(payload.queuedPrompt, childConfiguration);
    await call("POST", `${chatUrl}/turns`, 202, payload);
    const first = await entered(firstResponse);
    const root = first.input.client_metadata;
    assert.ok(root.thread_id && root.turn_id, JSON.stringify(root));
    assert.equal(first.input.model, model.model);
    let spawn = firstResponse;
    let spawnTool = findTool(first.input.tools, "spawn_agent");
    if (!spawnTool) {
      spawn = hold();
      firstResponse.toolSearch = { query: "spawn_agent", limit: 1 };
      firstResponse.release();
      const discovered = (await entered(spawn)).input.input.find(
        (item) => item.type === "tool_search_output",
      );
      spawnTool = tool(discovered?.tools, "spawn_agent");
    }
    const next = [hold("after-spawn-1"), hold("after-spawn-2")];
    const resumed = model.reply({
      text: "Child observed the declined approval.",
    });
    model.reply({
      onlyFor: ({ input }) =>
        input.model === model.model &&
        input.client_metadata.thread_id === root.thread_id &&
        input.input
          .at(-1)
          ?.content?.some(
            ({ text }) =>
              text?.startsWith("<subagent_notification>") &&
              text.includes(resumed.text),
          ),
      text: "The root acknowledged its child's completion.",
    });
    spawn.calls = [
      {
        ...spawnTool,
        arguments: {
          message: "Exercise a protected command approval in the child turn.",
          ...(spawnTool.namespace === "multi_agent_v1" ||
          spawnTool.name === "multi_agent_v1__spawn_agent"
            ? {}
            : { task_name: "approval" }),
        },
      },
    ];
    spawn.release();
    await Promise.all(next.map(entered));
    const parent = next.find(
      ({ request }) =>
        request.input.client_metadata.thread_id === root.thread_id,
    );
    const child = next.find((plan) => plan !== parent);
    assert.ok(parent && child);
    assert.equal(
      child.request.input.model,
      customModel ? childName : model.model,
    );
    if (customModel)
      assert.equal(child.request.input.reasoning?.effort, childEffort);
    const metadata = child.request.input.client_metadata;
    assert.equal(metadata.root_turn_id, root.turn_id);
    assert.ok(metadata.turn_id);
    assert.notEqual(metadata.turn_id, root.turn_id);
    child.calls = [
      {
        ...tool(child.request.input.tools, "exec_command"),
        arguments: {
          cmd: command,
          sandbox_permissions: "require_escalated",
          justification: "Exercise the local child approval fixture.",
        },
      },
    ];
    child.release();

    const [pending] = await eventually(
      () =>
        call("GET", `/api/agent-requests?chatId=${chatId}&status=pending`, 200),
      (rows) => {
        const earlyOutcome = resumed.request?.input.input.find(
          (item) => item.type === "function_call_output",
        );
        assert.equal(rows.length, 1, JSON.stringify(earlyOutcome));
        assert.equal(rows[0].classification?.kind, "commandExecution");
      },
    );
    assert.equal(pending.provenance.chatId, chatId);
    assert.equal(pending.provenance.threadId, metadata.thread_id);
    assert.equal(pending.provenance.turnId, metadata.turn_id);
    assert.ok(!JSON.stringify(pending).includes(command));
    const context = {
      ownerId,
      keyRevision,
      componentKey: interactionKey,
      requestKey: pending.requestKey,
    };
    const opened = await crypto.decryptInteractionRequestContent({
      ...context,
      encrypted: pending.protectedPayload,
      publicClassification: pending.classification,
    });
    assert.ok(opened.payload.command.includes(command));
    const response = { kind: "commandExecution", decision: "decline" };
    const protect = async (requestKey) => ({
      idempotencyKey: randomUUID(),
      classification: pending.classification,
      protectedResponse: await crypto.encryptInteractionResponseContent({
        ...context,
        requestKey,
        content: {
          version: 1,
          classification: pending.classification,
          response,
        },
      }),
    });
    const respond = `/api/agent-requests/${pending.id}/respond`;
    await call("POST", respond, 409, await protect("wrong-child-request"));
    assert.equal(resumed.entered, false);
    assert.equal(parent.request.completed, false);
    const protection = await protect(pending.requestKey);
    const settled = await call("POST", respond, 200, protection);
    assert.equal(settled.status, "resolved");
    const result = await crypto.decryptInteractionResponseContent({
      ...context,
      encrypted: settled.protectedResponse,
      publicClassification: settled.classification,
    });
    assert.deepEqual(result.response, response);
    await call("POST", respond, 409, {
      ...protection,
      idempotencyKey: randomUUID(),
    });
    const continued = await entered(resumed);
    assert.equal(continued.input.client_metadata.turn_id, metadata.turn_id);
    const outcome = continued.input.input.filter(
      (item) =>
        item.type === "function_call_output" &&
        item.call_id === `${child.responseId}-call-0`,
    );
    assert.equal(outcome.length, 1);
    assert.match(JSON.stringify(outcome[0].output), /reject|denied|declin/i);
    parent.text = "The root finished after the child approval.";
    parent.release();
    await eventually(
      () => parent.request.completed,
      (completed) => assert.ok(completed),
    );
    if (warm) {
      const { effective } = await eventually(refreshSettings, ({ effective }) =>
        assert.ok(effective),
      );
      assert.equal(effective.context.threadId, warm.effective.context.threadId);
      assert.equal(
        effective.context.runtimeGeneration,
        warm.effective.context.runtimeGeneration,
      );
      console.log(
        "The configured child used its provider model on the existing native runtime.",
      );
    }
    assert.deepEqual(model.failures, []);
    console.log(
      "An admitted root turn delivered one protected approval reply to its real Codex child.",
    );
  } finally {
    for (const plan of held) plan.release();
  }
}
