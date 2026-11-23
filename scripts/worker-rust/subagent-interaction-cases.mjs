import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as crypto from "../../packages/crypto/dist/index.js";
import { modelFunctions } from "../server-rust/task-model-provider.mjs";
import { createPreparedProjectChat } from "./console-interaction-cases.mjs";
import { previewOperations } from "./computer-use-preview-cases.mjs";

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
  computerUse,
  startWorker,
  stopWorker,
  chatKey,
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
      : computerUse
        ? {
            modelMetadata: {
              input_modalities: ["text", "image"],
              supports_vision: true,
            },
          }
        : [],
  );
  if (computerUse) {
    await call(
      "POST",
      `/api/settings/providers/${provider.id}/catalog/refresh?workerId=${workerId}`,
      200,
      {},
    );
  }
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: profile.id,
    defaultChatPermissionProfileId: ":workspace",
    autoNameChats: false,
    ...(computerUse ? { computerUseEnabled: true } : {}),
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
  let childProfile;
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
    childProfile = await call("POST", "/api/settings/models", 201, {
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
    const resumed = computerUse
      ? hold()
      : model.reply({ text: "Child observed the declined approval." });
    if (computerUse) resumed.text = "The child captured its fixture window.";
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
          message: computerUse
            ? "Use the managed computer-use tool in the child turn."
            : "Exercise a protected command approval in the child turn.",
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
    if (computerUse) {
      await verifyChildComputerUse({
        call,
        eventually,
        chatUrl,
        chatId,
        ownerId,
        workerId,
        keyRevision,
        interactionKey,
        ...computerUse,
        root,
        metadata,
        child,
        parent,
        resumed,
      });
      assert.deepEqual(model.failures, []);
      console.log(
        "Native child computer use kept approvals, images and retirement on the observed child turn.",
      );
      return;
    }
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
      const rootTurn = { threadId: root.thread_id, turnId: root.turn_id };
      const childTurn = {
        threadId: metadata.thread_id,
        turnId: metadata.turn_id,
      };
      const { id: serverId } = (await call("GET", "/api/bootstrap", 200))
        .server;
      const identities = [
        { ...rootTurn, isRoot: true, model: profile },
        { ...childTurn, isRoot: false, model: childProfile },
      ];
      const read = () =>
        call("POST", `${chatUrl}/native-history/turns/read`, 200, {
          turns: [rootTurn, childTurn],
        });
      const captures = ({ turns }) => {
        assert.equal(turns.length, 2);
        return identities.map(({ threadId, turnId, isRoot, model }) => {
          const entry = turns.find(
            ({ turn }) => turn.threadId === threadId && turn.turnId === turnId,
          );
          assert.equal(entry?.turn.status, "completed");
          const { modelAttribution, usage } = entry.turn;
          assert.deepEqual(modelAttribution?.selection, {
            status: "resolved",
            workerId,
            providerId: provider.id,
            providerAccountId: null,
            modelId: model.id,
            routeId: model.routes[0].id,
          });
          assert.equal(modelAttribution.isRoot, isRoot);
          if (!isRoot)
            assert.equal(modelAttribution.reasoningEffort, childEffort);
          assert.deepEqual(usage?.modelAttribution, modelAttribution);
          return entry;
        });
      };
      const archive = await eventually(read, captures, 35_000);
      for (const { turn, bindingId, workerId } of captures(archive)) {
        const evidence = await crypto.decryptNativeHistoryTurn({
          ownerId,
          serverId,
          componentKey: chatKey,
          chatId,
          bindingId,
          workerId,
          turn,
        });
        assert.deepEqual(
          evidence.reducedTurn.metadata.cantripModelAttribution,
          turn.modelAttribution,
        );
      }
      const usage = () =>
        call(
          "GET",
          `/api/analytics/provider-telemetry/${provider.id}/export`,
          200,
        );
      const checkUsage = ({ tokenUsage }) => {
        for (const { turn } of captures(archive)) {
          const source = `native-turn:${JSON.stringify([chatId, turn.threadId, turn.turnId])}`;
          const rows = tokenUsage.filter(
            ({ sourceKey }) => sourceKey === source,
          );
          assert.equal(rows.length, 1);
          const [row] = rows;
          assert.equal(row.modelId, turn.modelAttribution.selection.modelId);
          assert.equal(
            row.modelRouteId,
            turn.modelAttribution.selection.routeId,
          );
          assert.equal(
            row.reasoningEffort,
            turn.modelAttribution.reasoningEffort,
          );
          assert.ok(row.inputTokens > 0 && row.outputTokens > 0);
        }
      };
      await eventually(usage, checkUsage);
      assert.deepEqual(await stopWorker(), { code: 0, signal: null });
      await startWorker();
      captures(await read());
      checkUsage(await usage());
      console.log(
        "Root and child attribution remained distinct in encrypted History and usage after worker restart.",
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

async function verifyChildComputerUse({
  call,
  eventually,
  chatId,
  chatUrl,
  ownerId,
  workerId,
  keyRevision,
  interactionKey,
  previewKey,
  openMessage,
  root,
  metadata,
  child,
  parent,
  resumed,
}) {
  const tool = modelFunctions(child.request.input.tools).find(
    ({ name, namespace }) =>
      name === "mcp__cantrip_cua__js" ||
      (name === "js" && namespace?.includes("cantrip_cua")),
  );
  assert.ok(tool, "The bundled child runtime exposes native computer use.");
  const target = { targetId: "fake-window", targetGeneration: 1 };
  child.calls = [
    {
      ...tool,
      arguments: {
        script:
          "await cua.attach({targetId:'fake-window',targetGeneration:1}); await cua.snapshot()",
      },
    },
  ];
  child.release();

  async function approve(kind, permission) {
    const [record] = await eventually(
      () =>
        call("GET", `/api/agent-requests?chatId=${chatId}&status=pending`, 200),
      (rows) => {
        const outputs = resumed.request?.input?.input?.filter(
          (item) => item.type === "function_call_output",
        );
        assert.equal(rows.length, 1, JSON.stringify(outputs));
        assert.equal(rows[0].classification?.kind, kind);
      },
    );
    assert.equal(record.provenance.chatId, chatId);
    assert.equal(record.provenance.threadId, metadata.thread_id);
    assert.equal(record.provenance.turnId, metadata.turn_id);
    const material = {
      ownerId,
      keyRevision,
      componentKey: interactionKey,
      requestKey: record.requestKey,
    };
    const { payload } = await crypto.decryptInteractionRequestContent({
      ...material,
      encrypted: record.protectedPayload,
      publicClassification: record.classification,
    });
    let response;
    if (permission) {
      assert.equal(record.provenance.owner, "computer-use");
      const permissions = {
        computerUse: { version: 1, classes: [permission], target },
      };
      assert.deepEqual(payload.requestedPermissions, permissions);
      response = { kind, scope: "turn", permissions, strictAutoReview: false };
    } else {
      assert.equal(payload.serverName, "cantrip_cua");
      response = { kind, action: "accept", content: {}, metadata: null };
    }
    const resolved = await call(
      "POST",
      `/api/agent-requests/${record.id}/respond`,
      200,
      {
        idempotencyKey: randomUUID(),
        classification: record.classification,
        protectedResponse: await crypto.encryptInteractionResponseContent({
          ...material,
          content: {
            version: 1,
            classification: record.classification,
            response,
          },
        }),
      },
    );
    assert.equal(resolved.status, "resolved");
  }
  await approve("mcpElicitation");
  await approve("permissions", "inventory");
  await approve("permissions", "capture");
  const result = await eventually(
    () => resumed.request,
    (value) =>
      assert.equal(value?.input.client_metadata.turn_id, metadata.turn_id),
  );
  const image = result.input.input
    .filter((item) => item.type === "function_call_output")
    .flatMap((item) => item.output)
    .find((part) => part.type === "input_image");
  assert.match(image?.image_url ?? "", /^data:image\/png;base64,/);
  const bytes = Buffer.from(image.image_url.split(",")[1], "base64");
  const { server } = await call("GET", "/api/bootstrap", 200);
  const base = chatUrl + "/computer-use";
  const lease = await call("POST", base + "/preview", 200, {});
  const preview = { ownerId, keyRevision, componentKey: previewKey };
  const { operate } = previewOperations({
    call,
    base,
    serverId: server.id,
    workerId,
    chatId,
    lease,
    seal: (context, plaintext) =>
      crypto.encryptEndpointContentPayload({ ...preview, context, plaintext }),
    open: (context, opaque) =>
      crypto.decryptEndpointContentPayload({ ...preview, context, opaque }),
  });
  const list = { operation: "agent.sources.list" };
  const sources = async () => (await operate(list)).result.data.sources;
  const [source] = await eventually(sources, (items) =>
    assert.equal(items.length, 1),
  );
  assert.equal(source.rootThreadId, root.thread_id);
  assert.equal(source.binding.threadId, metadata.thread_id);
  assert.equal(source.binding.turnId, metadata.turn_id);
  const read = {
    operation: "agent.observation.get",
    sourceId: source.sourceId,
  };
  const observation = await operate(read);
  assert.equal(observation.result.status, "ok");
  assert.equal(Buffer.compare(observation.payload, bytes), 0);
  observation.payload.fill(0);
  bytes.fill(0);

  await eventually(
    async () => {
      const history = await call("GET", `${chatUrl}/messages`, 200);
      const messages = await Promise.all(history.messages.map(openMessage));
      return messages
        .flatMap(({ content }) => content)
        .filter(
          ({ type, activity }) =>
            type === "activity" &&
            activity.type === "computerUse" &&
            activity.source === "agent-mcp",
        )
        .map(({ activity }) => activity);
    },
    (activities) => {
      assert.deepEqual(
        activities.map(({ operation }) => operation),
        ["target.attach", "observation.snapshot", "js.evaluate"],
      );
      for (const activity of activities) {
        assert.equal(activity.binding.threadId, metadata.thread_id);
        assert.equal(activity.binding.turnId, metadata.turn_id);
        assert.equal(activity.agentScope.agentThreadId, metadata.thread_id);
        assert.equal(activity.agentScope.parentThreadId, root.thread_id);
        assert.equal(activity.agentScope.rootThreadId, root.thread_id);
        assert.equal(activity.agentScope.rootTurnId, root.turn_id);
        assert.equal(activity.agentScope.isRoot, false);
      }
    },
  );
  resumed.release();
  await eventually(sources, (items) => assert.deepEqual(items, []));
  assert.equal((await operate(read)).result.code, "execution-unavailable");
  assert.equal(
    parent.request.completed,
    false,
    "The parent turn remains active.",
  );
  parent.text = "The root finished after the child capture.";
  parent.release();
  await eventually(
    () => parent.request.completed,
    (completed) => assert.ok(completed),
  );
}
