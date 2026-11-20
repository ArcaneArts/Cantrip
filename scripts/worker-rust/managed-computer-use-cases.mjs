import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  decryptInteractionRequestContent,
  encryptInteractionResponseContent,
} from "../../packages/crypto/dist/index.js";
import { modelFunctions } from "../server-rust/task-model-provider.mjs";

export async function verifyManagedComputerUse({
  call,
  eventually,
  createChat,
  createModel,
  encryptedTurn,
  ownerId,
  workerId,
  keyRevision,
  interactionKey,
  openMessage,
}) {
  const { model, profile, provider } = await createModel(
    "Native computer-use agent fixture",
    undefined,
    {
      modelMetadata: {
        input_modalities: ["text", "image"],
        supports_vision: true,
      },
    },
  );
  const catalog = await call(
    "POST",
    `/api/settings/providers/${provider.id}/catalog/refresh?workerId=${encodeURIComponent(workerId)}`,
    200,
    {},
  );
  assert.ok(
    catalog.models
      .find((entry) => entry.nativeModelId === model.model)
      ?.inputModalities.includes("image"),
  );
  await call("PATCH", "/api/settings", 200, {
    computerUseEnabled: true,
    defaultModelId: profile.id,
    defaultChatPermissionProfileId: ":workspace",
    autoNameChats: false,
  });
  const { chatId, chatUrl } = await createChat(
    "Managed native computer use",
    false,
  );
  const tools = model.reply({ hold: true });
  const captured = model.reply({ hold: true });
  const finished = model.reply({ text: "The fixture capture completed." });
  await call(
    "POST",
    chatUrl + "/turns",
    202,
    await encryptedTurn("Observe the fixture window.", profile.id),
  );
  await eventually(
    () => tools.entered,
    (entered) => assert.equal(entered, true),
  );
  const available = modelFunctions(tools.request.input.tools);
  const tool = (name) =>
    available.find(
      (entry) =>
        entry.name === `mcp__cantrip_cua__${name}` ||
        (entry.name === name && entry.namespace?.includes("cantrip_cua")),
    );
  const js = tool("js");
  const reset = tool("js_reset");
  assert.ok(js, `Native CUA tool is missing from ${JSON.stringify(available)}`);
  assert.ok(reset);
  tools.calls = [
    {
      ...js,
      arguments: {
        script:
          "const t = (await cua.targets()).targets.find(t => t.id === 'fake-window'); await cua.attach({targetId:t.id,targetGeneration:t.generation}); const image = await cua.snapshot(); let decline; try { await cua.readClipboard(); } catch (error) { decline = error.code; } ({imageIndex: image.imageIndex, decline, marker: 'fixture-private-script'})",
      },
    },
  ];
  tools.release();

  const material = { ownerId, keyRevision, componentKey: interactionKey };
  async function pending() {
    const [record] = await eventually(
      () =>
        call("GET", `/api/agent-requests?chatId=${chatId}&status=pending`, 200),
      (items) => assert.equal(items.length, 1),
    );
    const request = await decryptInteractionRequestContent({
      ...material,
      requestKey: record.requestKey,
      encrypted: record.protectedPayload,
      publicClassification: record.classification,
    });
    return [record, request.payload];
  }

  async function respond(record, response) {
    const resolved = await call(
      "POST",
      `/api/agent-requests/${record.id}/respond`,
      200,
      {
        idempotencyKey: randomUUID(),
        classification: record.classification,
        protectedResponse: await encryptInteractionResponseContent({
          ...material,
          requestKey: record.requestKey,
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

  const [confirmation, elicitation] = await pending();
  assert.equal(elicitation.kind, "mcpElicitation");
  assert.equal(elicitation.serverName, "cantrip_cua");
  await respond(confirmation, {
    kind: "mcpElicitation",
    action: "accept",
    content: {},
    metadata: null,
  });

  let provenance;
  for (const [permission, target] of [
    ["inventory", null],
    ["inventory", { targetId: "fake-window", targetGeneration: 1 }],
    ["capture", { targetId: "fake-window", targetGeneration: 1 }],
    ["native-input", { targetId: "fake-window", targetGeneration: 1 }],
  ]) {
    const [record, request] = await pending();
    assert.equal(record.provenance.owner, "computer-use");
    assert.equal(record.provenance.chatId, chatId);
    assert.equal(record.provenance.workerId, workerId);
    for (const id of ["threadId", "turnId", "executionLaneId"])
      assert.ok(record.provenance[id]);
    if (provenance) assert.deepEqual(record.provenance, provenance);
    provenance = record.provenance;
    const permissions = {
      computerUse: { version: 1, classes: [permission], target },
    };
    assert.deepEqual(request.requestedPermissions, permissions);
    await respond(record, {
      kind: "permissions",
      scope: "turn",
      permissions: permission === "native-input" ? {} : permissions,
      strictAutoReview: false,
    });
  }
  await eventually(
    () => captured.entered,
    (entered) => assert.equal(entered, true),
  );
  const toolOutputs = (reply) =>
    reply.request.input.input
      .filter((item) => item.type === "function_call_output")
      .flatMap((item) => item.output);
  const parts = toolOutputs(captured);
  const image = parts.find((part) => part.type === "input_image");
  assert.match(
    image?.image_url ?? "",
    /^data:image\/png;base64,[A-Za-z0-9+/]+/u,
    `Missing the model image. Output parts: ${JSON.stringify(parts.map((part) => ({ type: part.type, text: part.text?.slice(0, 100), url: part.image_url?.slice(0, 40) })))}`,
  );
  const report = parts.find(
    (part) => part.type === "input_text" && part.text.startsWith('{"value":'),
  );
  assert.ok(report);
  const result = JSON.parse(report.text);
  assert.equal(result.value.decline, "permission-denied");
  const { native, model: rendition } = result.images[0];
  const bytes = Buffer.from(image.image_url.split(",")[1], "base64");
  assert.equal(native.image.mediaType, "image/png");
  assert.equal(rendition.byteCount, bytes.length);
  assert.equal(
    rendition.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.equal(rendition.sha256, native.image.sha256);

  captured.calls = [{ ...reset, arguments: {} }];
  captured.release();
  await eventually(
    () => finished.request,
    (request) => assert.equal(request?.completed, true),
  );
  assert.ok(
    toolOutputs(finished).some((part) =>
      part.text?.includes("JavaScript state and target attachment reset."),
    ),
  );
  await eventually(
    async () => {
      const history = await call("GET", chatUrl + "/messages", 200);
      assert.doesNotMatch(
        JSON.stringify(history),
        /fixture-private-script|fake-window|computer-use\//,
      );
      return Promise.all(history.messages.map(openMessage));
    },
    (messages) => {
      assert.ok(
        messages.some((message) =>
          message.content.some(
            (item) => item.text === "The fixture capture completed.",
          ),
        ),
      );
      const activities = messages
        .flatMap(({ content }) => content)
        .filter(
          ({ type, activity }) =>
            type === "activity" && activity.type === "computerUse",
        )
        .map(({ activity }) => activity);
      assert.deepEqual(
        activities.map(({ operation, outcome }) => [operation, outcome]),
        [
          ["targets.list", "completed"],
          ["target.attach", "completed"],
          ["observation.snapshot", "completed"],
          ["clipboard.read", "declined"],
          ["js.evaluate", "completed"],
          ["js.reset", "completed"],
        ],
      );
      const captured = activities.find(
        ({ operation }) => operation === "observation.snapshot",
      );
      assert.equal(captured.observation.image.sha256, native.image.sha256);
      assert.deepEqual(captured.target, {
        targetId: "fake-window",
        targetGeneration: 1,
      });
      assert.equal(
        captured.binding.sessionId,
        native.session.binding.sessionId,
      );
      const terminal = activities.find(
        ({ operation }) => operation === "js.evaluate",
      );
      assert.equal(terminal.operationId, terminal.requestId);
      const reset = activities.find(
        ({ operation }) => operation === "js.reset",
      );
      assert.notEqual(reset.requestId, terminal.requestId);
      for (const activity of activities) {
        if (activity !== reset)
          assert.equal(activity.requestId, terminal.requestId);
        const { sessionId, ...binding } = activity.binding;
        assert.deepEqual(binding, {
          chatId,
          taskId: null,
          workerId,
          threadId: provenance.threadId,
          turnId: provenance.turnId,
        });
        assert.equal(
          sessionId,
          activity.operation === "targets.list"
            ? null
            : captured.binding.sessionId,
        );
        assert.equal(activity.agentScope.agentThreadId, provenance.threadId);
        assert.equal(activity.agentScope.rootTurnId, provenance.turnId);
        assert.equal(activity.agentScope.isRoot, true);
        assert.equal(activity.raw.request, null);
        assert.equal(activity.raw.response, null);
        assert.equal(activity.correlation.diagnosticId, activity.operationId);
        assert.ok(activity.correlation.itemId);
      }
      assert.doesNotMatch(
        JSON.stringify(activities),
        /fixture-private-script|iVBORw0KGgo/,
      );
    },
  );
  assert.deepEqual(model.failures, []);
  console.log(
    JSON.stringify({ suite: "native-managed-computer-use", passed: true }),
  );
}
