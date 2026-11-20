import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  decryptEndpointContentPayload,
  decryptInteractionRequestContent,
  encryptEndpointContentPayload,
  encryptInteractionResponseContent,
} from "../../packages/crypto/dist/index.js";
import { modelFunctions } from "../server-rust/task-model-provider.mjs";
import {
  createComputerUseTask,
  previewOperations,
} from "./computer-use-preview-cases.mjs";
import { recoverHeldTurn } from "./deferred-receipt-smoke-cases.mjs";
import {
  createPreparedProjectChat,
  openConsoleView,
} from "./console-interaction-cases.mjs";

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
  previewKey,
  console: managedConsole,
  recovery,
  autonomous,
  task,
  guest,
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
  const title = "Managed native computer use";
  const project = managedConsole ?? autonomous ?? guest;
  const preparedTask = task
    ? await createComputerUseTask({
        call,
        eventually,
        ownerId,
        workerId,
        keyRevision,
        ...task,
        brief: "Observe the fixture window.",
        planGoalEnabled: task.goal ?? false,
      })
    : null;
  const { chatId, chatUrl, placement } =
    preparedTask ??
    (project
      ? await createPreparedProjectChat({
          call,
          eventually,
          ownerId,
          workerId,
          keyRevision,
          labelKey: project.labelKey,
          title,
          beforeChat: guest
            ? ({ projectId }) =>
                guest.desktop.placeProject({
                  call,
                  projectId,
                  workerId,
                  ownerId,
                  keyRevision,
                  repositoryKey: guest.repositoryKey,
                })
            : undefined,
        })
      : await createChat(title, false));
  const taskUrl = preparedTask ? `/api/tasks/${chatId}` : null;
  const reviewed = task?.goal
    ? await reviewTaskPlan({ call, eventually, model }, preparedTask)
    : null;
  const finalizer = reviewed
    ? model.reply({
        hold: true,
        text: JSON.stringify({
          finalPlanMarkdown: "# Inspect the fixture window",
          goalPrompt: "Observe the fixture window and report the result.",
        }),
      })
    : null;
  const beforePause = recovery ? model.reply({ hold: true }) : null;
  const tools = model.reply({ hold: true });
  const captured = model.reply({ hold: true });
  const afterReset = model.reply({ hold: true });
  const completeGoal =
    autonomous || reviewed ? model.reply({ hold: true }) : null;
  const finished = model.reply({
    hold: true,
    text: "The fixture capture completed.",
  });
  const prompt = "Observe the fixture window.";
  let expectedTurn;
  if (managedConsole) {
    const url = await eventually(
      () => readFile(managedConsole.socketFile, "utf8"),
      (value) => assert.ok(value.startsWith("ws://127.0.0.1:")),
    );
    const view = await openConsoleView(url, eventually);
    try {
      const { threadId } = view;
      const restored = await view.request(2, "thread/resume", { threadId });
      assert.equal(
        restored.result?.thread.id,
        threadId,
        JSON.stringify(restored),
      );
      const started = await view.request(3, "turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      });
      assert.ok(started.result?.turn?.id, JSON.stringify(started));
      expectedTurn = { threadId, turnId: started.result.turn.id };
    } finally {
      view.close();
    }
  } else if (autonomous) {
    await call("POST", `${chatUrl}/goal?encrypted=1`, 202, {
      objective: prompt,
      tokenBudget: 50_000,
    });
  } else if (reviewed) {
    await call("POST", taskUrl + "/begin-implementation", 202, {
      operationId: randomUUID(),
      rowVersion: reviewed.rowVersion,
    });
    await readOnlyPlan(finalizer, eventually);
  } else if (preparedTask) {
    await call("POST", taskUrl + "/start", 202, {
      operationId: randomUUID(),
      rowVersion: preparedTask.rowVersion,
    });
  } else {
    await call(
      "POST",
      chatUrl + "/turns",
      202,
      await encryptedTurn(prompt, profile.id),
    );
  }
  if (recovery) {
    expectedTurn = await recoverHeldTurn({
      ...recovery,
      call,
      eventually,
      chatUrl,
      beforePause,
      afterResume: tools,
    });
  }
  await eventually(
    () => tools.entered,
    (entered) => assert.equal(entered, true),
  );
  if (autonomous) {
    const admission = autonomous.admission();
    assert.ok(admission?.intent.autonomousAttempt.goalEpoch);
    assert.equal(admission.origin, "autonomous");
    assert.equal(admission.session.chatId, chatId);
    expectedTurn = {
      threadId: admission.session.threadId,
      turnId: admission.intent.autonomousAttempt.turnId,
    };
  }
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
  const matchTarget = guest ? "t.kind === 'monitor'" : "t.id === 'fake-window'";
  const findTarget = `const t = (await cua.targets()).targets.find(t => ${matchTarget});`;
  const attachTarget =
    "await cua.attach({targetId:t.id,targetGeneration:t.generation});";
  tools.calls = [
    {
      ...js,
      arguments: {
        script: `${findTarget} ${attachTarget} await cua.snapshot(); const image = await cua.snapshot(); let decline; try { await cua.readClipboard(); } catch (error) { decline = error.code; } ({imageIndex: image.imageIndex, decline, marker: 'fixture-private-script'})`,
      },
    },
  ];
  tools.release();

  const material = { ownerId, keyRevision, componentKey: interactionKey };
  const pendingRecords = () =>
    call("GET", `/api/agent-requests?chatId=${chatId}&status=pending`, 200);
  async function pending(toolReply) {
    const [record] = await eventually(pendingRecords, (items) => {
      assert.ok(
        !toolReply?.entered,
        `The tool returned before requesting approval: ${JSON.stringify(toolReply?.request?.input?.input?.filter((item) => item.type === "function_call_output"))}`,
      );
      assert.equal(items.length, 1);
    });
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

  async function confirmTool(toolReply) {
    const [confirmation, elicitation] = await pending(toolReply);
    assert.equal(elicitation.kind, "mcpElicitation");
    assert.equal(elicitation.serverName, "cantrip_cua");
    await respond(confirmation, {
      kind: "mcpElicitation",
      action: "accept",
      content: {},
      metadata: null,
    });
  }
  await confirmTool(captured);

  let provenance;
  let scopedTarget = guest
    ? null
    : { targetId: "fake-window", targetGeneration: 1 };
  for (const [permission, scoped] of [
    ["inventory", false],
    ["inventory", true],
    ["capture", true],
    ["native-input", true],
  ]) {
    const [record, request] = await pending();
    if (scoped && !scopedTarget) {
      scopedTarget = request.requestedPermissions.computerUse?.target;
      assert.ok(scopedTarget?.targetId && scopedTarget?.targetGeneration);
      assert.notEqual(scopedTarget.targetId, "fake-window");
    }
    const target = scoped ? scopedTarget : null;
    assert.equal(record.provenance.owner, "computer-use");
    assert.equal(record.provenance.chatId, chatId);
    assert.equal(record.provenance.workerId, workerId);
    for (const id of ["threadId", "turnId", "executionLaneId"])
      assert.ok(record.provenance[id]);
    if (expectedTurn) {
      assert.equal(record.provenance.threadId, expectedTurn.threadId);
      assert.equal(record.provenance.turnId, expectedTurn.turnId);
    }
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
  const images = parts.filter((part) => part.type === "input_image");
  assert.equal(images.length, 2);
  const image = images.at(-1);
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
  assert.equal(result.value.imageIndex, 1);
  const { native, model: rendition } = result.images.at(-1);
  const bytes = Buffer.from(image.image_url.split(",")[1], "base64");
  assert.equal(native.image.mediaType, "image/png");
  assert.equal(rendition.byteCount, bytes.length);
  assert.equal(
    rendition.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.equal(rendition.sha256, native.image.sha256);

  const { server } = await call("GET", "/api/bootstrap", 200);
  const previewMaterial = { ownerId, keyRevision, componentKey: previewKey };
  async function preview(chatId, chatUrl) {
    const base = chatUrl + "/computer-use";
    const lease = await call("POST", base + "/preview", 200, {});
    if (preparedTask && chatId === preparedTask.chatId)
      assert.equal(lease.contentDomain, "task");
    const operations = previewOperations({
      call,
      base,
      serverId: server.id,
      workerId,
      chatId,
      lease,
      seal: (context, plaintext) =>
        encryptEndpointContentPayload({
          ...previewMaterial,
          context,
          plaintext,
        }),
      open: (context, opaque) =>
        decryptEndpointContentPayload({ ...previewMaterial, context, opaque }),
    });
    return {
      operate: operations.operate,
      stop: () =>
        call("POST", base + "/preview/stop", 200, {
          workerId,
          leaseId: lease.leaseId,
        }),
    };
  }
  const { operate, stop } = await preview(chatId, chatUrl);
  if (guest) {
    const connections = await guest.desktop.connections();
    assert.equal(connections[placement.guestWorkspaceId]?.running, true);
  }
  const list = { operation: "agent.sources.list" };
  const sources = (await operate(list)).result.data.sources;
  assert.equal(sources.length, 1);
  const [source] = sources;
  assert.equal(source.rootThreadId, provenance.threadId);
  assert.deepEqual(source.binding, native.session.binding);
  assert.equal(source.binding.taskId, preparedTask ? chatId : null);
  assert.equal(source.observationRevision, native.session.observationRevision);
  assert.ok(
    source.observationRevision >
      result.images[0].native.session.observationRevision,
  );
  const get = { operation: "agent.observation.get", sourceId: source.sourceId };
  const observation = await operate(get);
  assert.equal(observation.result.status, "ok");
  assert.deepEqual(observation.result.data.source, source);
  assert.deepEqual(observation.result.data.nativeImage, native.image);
  assert.equal(Buffer.compare(observation.payload, bytes), 0);
  observation.payload.fill(0);
  bytes.fill(0);

  const other = await createChat("Other preview", false);
  const { operate: foreign } = await preview(other.chatId, other.chatUrl);
  assert.deepEqual((await foreign(list)).result.data.sources, []);
  const unavailable = (await foreign(get)).result;
  assert.equal(unavailable.code, "execution-unavailable");

  captured.calls = [{ ...reset, arguments: {} }];
  captured.release();
  await eventually(
    () => afterReset.entered,
    (entered) => assert.equal(entered, true),
  );
  assert.ok(
    toolOutputs(afterReset).some((part) =>
      part.text?.includes("JavaScript state and target attachment reset."),
    ),
  );
  assert.deepEqual((await operate(list)).result.data.sources, []);
  assert.equal((await operate(get)).result.code, "execution-unavailable");

  afterReset.calls = [
    {
      ...js,
      arguments: {
        script: guest
          ? `${findTarget} ${attachTarget} await cua.snapshot()`
          : `await cua.attach(${JSON.stringify(scopedTarget)}); await cua.snapshot()`,
      },
    },
  ];
  afterReset.release();
  const afterCapture = completeGoal ?? finished;
  await eventually(pendingRecords, (records) =>
    assert.ok(afterCapture.entered || records.length === 1),
  );
  if (guest) {
    let approval = await pending(afterCapture);
    if (approval[1].kind === "mcpElicitation") {
      await confirmTool(afterCapture);
      approval = await pending(afterCapture);
    }
    const newTarget = approval[1].requestedPermissions.computerUse.target;
    assert.ok(newTarget?.targetId && newTarget?.targetGeneration);
    assert.notDeepEqual(newTarget, scopedTarget);
    for (const permission of ["inventory", "capture"]) {
      const [record, request] = approval;
      assert.deepEqual(record.provenance, provenance);
      const permissions = {
        computerUse: { version: 1, classes: [permission], target: newTarget },
      };
      assert.deepEqual(request.requestedPermissions, permissions);
      await respond(record, {
        kind: "permissions",
        scope: "turn",
        permissions,
        strictAutoReview: false,
      });
      if (permission === "inventory") approval = await pending(afterCapture);
    }
  } else if (!afterCapture.entered) {
    await confirmTool();
  }
  await eventually(
    () => afterCapture.entered,
    (entered) => assert.equal(entered, true),
  );
  const afterResetSources = (await operate(list)).result.data.sources;
  assert.equal(
    afterResetSources.length,
    1,
    "A fresh capture is retained after reset.",
  );
  const [replacement] = afterResetSources;
  assert.notEqual(replacement.sourceId, source.sourceId);
  assert.notEqual(replacement.binding.sessionId, source.binding.sessionId);
  if (completeGoal) {
    const update = modelFunctions(completeGoal.request.input.tools).find(
      ({ name }) => name === "update_goal" || name.endsWith("__update_goal"),
    );
    assert.ok(update, "The autonomous turn exposes native Goal completion.");
    completeGoal.calls = [{ ...update, arguments: { status: "complete" } }];
    completeGoal.release();
    await eventually(
      () => finished.entered,
      (entered) => assert.equal(entered, true),
    );
  }
  finished.release();
  await eventually(
    () => finished.request,
    (request) => assert.equal(request?.completed, true),
  );
  await eventually(
    async () => {
      const history = await call("GET", chatUrl + "/messages", 200);
      assert.doesNotMatch(
        JSON.stringify(history),
        /fixture-private-script|fake-window|computer-use\//,
      );
      if (preparedTask) assert.equal(history.kind, "task-encrypted");
      return Promise.all(
        history.messages.map(preparedTask?.openMessage ?? openMessage),
      );
    },
    (messages) => {
      assert.ok(
        messages.some((message) =>
          message.content.some(
            (item) => item.text === "The fixture capture completed.",
          ),
        ),
      );
      if (recovery) {
        assert.equal(
          messages.filter(({ classification, content }) =>
            reviewed
              ? classification.role === "user" && classification.mode === "goal"
              : content.some(({ text }) => text === prompt),
          ).length,
          1,
        );
      }
      const activities = messages
        .flatMap(({ content }) => content)
        .filter(
          ({ type, activity }) =>
            type === "activity" &&
            activity.type === "computerUse" &&
            activity.source === "agent-mcp",
        )
        .map(({ activity }) => activity);
      assert.deepEqual(
        activities.map(({ operation, outcome }) => [operation, outcome]),
        [
          ["targets.list", "completed"],
          ["target.attach", "completed"],
          ["observation.snapshot", "completed"],
          ["observation.snapshot", "completed"],
          ["clipboard.read", "declined"],
          ["js.evaluate", "completed"],
          ["js.reset", "completed"],
          ...(guest ? [["targets.list", "completed"]] : []),
          ["target.attach", "completed"],
          ["observation.snapshot", "completed"],
          ["js.evaluate", "completed"],
        ],
      );
      const captured = activities.find(
        ({ operation, observation, binding }) =>
          operation === "observation.snapshot" &&
          observation.revision === source.observationRevision &&
          binding.sessionId === source.binding.sessionId,
      );
      assert.equal(captured.observation.image.sha256, native.image.sha256);
      assert.deepEqual(captured.target, scopedTarget);
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
      for (const [index, activity] of activities.entries()) {
        if (index < activities.indexOf(reset))
          assert.equal(activity.requestId, terminal.requestId);
        const { sessionId, ...binding } = activity.binding;
        assert.deepEqual(binding, {
          chatId,
          taskId: preparedTask ? chatId : null,
          workerId,
          threadId: provenance.threadId,
          turnId: provenance.turnId,
        });
        assert.equal(
          sessionId,
          activity.operation === "targets.list"
            ? null
            : index <= activities.indexOf(reset)
              ? captured.binding.sessionId
              : replacement.binding.sessionId,
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
  // The final message can reach History before Codex completes the turn.
  await eventually(
    () => operate(list),
    ({ result }) => assert.deepEqual(result.data.sources, []),
  );
  assert.equal(
    (await operate({ ...get, sourceId: replacement.sourceId })).result.code,
    "execution-unavailable",
  );
  if (guest) {
    await stop();
    await eventually(
      () => guest.desktop.connections(),
      (connections) => assert.deepEqual(connections, {}),
    );
  }
  if (autonomous) {
    await eventually(
      () => call("GET", `${chatUrl}/goal?encrypted=1`, 200),
      ({ goal }) => assert.equal(goal?.status, "complete"),
    );
  }
  if (preparedTask) {
    await eventually(
      () => call("GET", taskUrl, 200),
      ({ state }) => assert.equal(state, "complete"),
    );
  }
  if (preparedTask && !reviewed) {
    const plan = await createComputerUseTask({
      call,
      eventually,
      ownerId,
      workerId,
      keyRevision,
      ...task,
      brief: "Plan the read-only fixture.",
      planGoalEnabled: true,
      projectId: preparedTask.projectId,
    });
    await reviewTaskPlan({ call, eventually, model }, plan);
  }
  assert.deepEqual(model.failures, []);
  console.log(
    JSON.stringify({
      suite: [
        "native",
        guest ? "guest" : reviewed ? "task-goal" : preparedTask ? "task" : null,
        recovery
          ? "recovered"
          : managedConsole
            ? "console"
            : autonomous
              ? "autonomous"
              : preparedTask || guest
                ? null
                : "managed",
        "computer-use",
      ]
        .filter(Boolean)
        .join("-"),
      passed: true,
    }),
  );
}

async function reviewTaskPlan(
  { call, eventually, model },
  { chatId, rowVersion },
) {
  const planner = model.reply({
    hold: true,
    text: JSON.stringify({
      planMarkdown: "# Inspect the fixture",
      questions: [],
    }),
  });
  const taskUrl = `/api/tasks/${chatId}`;
  await call("POST", taskUrl + "/plan", 202, {
    operationId: randomUUID(),
    rowVersion,
  });
  await readOnlyPlan(planner, eventually);
  return eventually(
    () => call("GET", taskUrl, 200),
    ({ state }) => assert.equal(state, "review"),
  );
}

async function readOnlyPlan(reply, eventually) {
  await eventually(
    () => reply.entered,
    (entered) => assert.equal(entered, true),
  );
  assert.ok(
    modelFunctions(reply.request.input.tools).every(
      ({ name, namespace }) =>
        !name.includes("cantrip_cua") && !namespace?.includes("cantrip_cua"),
    ),
    "A read-only Task round does not receive computer-use tools.",
  );
  reply.release();
}
