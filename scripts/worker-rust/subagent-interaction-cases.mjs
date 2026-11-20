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
}) {
  const { model, profile } = await createModel("Subagent approval model", 3);
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
  const command = "printf cantrip-private-child-approval-fixture";
  const search = model.reply({
    toolSearch: { query: "spawn_agent", limit: 1 },
  });
  const spawn = model.reply({ hold: true });
  const next = ["after-spawn-1", "after-spawn-2"].map((responseId) =>
    model.reply({ hold: true, responseId }),
  );
  const resumed = model.reply({
    text: "Child observed the declined approval.",
  });
  const entered = (plan) =>
    eventually(
      () => plan.request,
      (request) => assert.ok(request),
    );
  const tool = (tools, name) => {
    const entry = modelFunctions(tools).find(
      (candidate) => candidate.name === name,
    );
    assert.ok(entry, `Bundled Codex advertises ${name}`);
    return entry;
  };
  try {
    await call(
      "POST",
      `${chatUrl}/turns`,
      202,
      await encryptedTurn("Delegate one local approval fixture.", profile.id),
    );
    const first = await entered(spawn);
    const root = first.input.client_metadata;
    assert.ok(root.thread_id && root.turn_id, JSON.stringify(root));
    assert.ok(search.request.completed);
    const discovered = first.input.input.find(
      (item) => item.type === "tool_search_output",
    );
    const spawnTool = tool(discovered?.tools, "spawn_agent");
    spawn.calls = [
      {
        ...spawnTool,
        arguments: {
          message: "Exercise a protected command approval in the child turn.",
          ...(spawnTool.namespace === "multi_agent_v1"
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
    parent.release();
    await eventually(
      () => parent.request.completed,
      (completed) => assert.ok(completed),
    );
    assert.deepEqual(model.failures, []);
    console.log(
      "An admitted root turn delivered one protected approval reply to its real Codex child.",
    );
  } finally {
    spawn.release();
    for (const plan of next) plan.release();
  }
}
