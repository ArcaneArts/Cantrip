import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eventually } from "./full-worker.mjs";
import { modelFunctions } from "./task-model-provider.mjs";
import { projectToolOutput } from "./actual-council-project-creation.mjs";

import {
  prepareCouncilMcpFixture,
  disposableCredential,
  discoveredValue,
  setupName,
} from "./council-mcp-fixture.mjs";
const timeout = 60_000;

export function modelOutput(plan, callId) {
  const item = plan.request.input.input.find(
    ({ type, call_id }) =>
      type === "function_call_output" && call_id === callId,
  );
  assert.ok(item, `Missing tool output ${callId}`);
  return typeof item.output === "string"
    ? item.output
    : item.output.map(({ text }) => text).join("\n");
}

export async function actualCouncilMcpSetup({
  page,
  root,
  chatId,
  workerId,
  model,
  tools,
  submit,
  readChat,
  result,
}) {
  const command = tools.find(({ name }) => name === "exec_command");
  const setup = tools.find(({ name }) => name.endsWith("council_mcp_setup"));
  assert.ok(command && setup, "Set up MCP through the normal Council tool");
  const { configuration, scriptArguments } =
    await prepareCouncilMcpFixture(root);
  const settingsWire = () =>
    page.evaluate(() => window.folderRequest("/api/settings/mcp-servers"));
  const interaction = (method, ...args) =>
    page.evaluate(
      async ({ method, args }) =>
        (await import("/src/lib/api/chats.ts"))[method](...args),
      { method, args },
    );
  const accepted = new Map();
  const complete = (plan) =>
    eventually(
      async () => {
        if (plan.request?.completed) return true;
        const pending = await interaction("getAgentInteractionRequests", {
          chatId,
          status: "pending",
        });
        for (const request of pending.filter(({ id }) => !accepted.has(id))) {
          const { kind } = request.payload;
          let response;
          if (kind === "mcpElicitation") {
            assert.equal(request.payload.serverName, "cantrip");
            response = { kind, action: "accept", content: {}, metadata: null };
          } else {
            assert.equal(kind, "commandExecution");
            assert.match(request.payload.command ?? "", /council-mcp-client/u);
            response = { kind, decision: "accept" };
          }
          await interaction("respondToAgentInteractionRequest", request.id, {
            idempotencyKey: randomUUID(),
            response,
          });
          accepted.set(request.id, kind);
        }
        return false;
      },
      (completed) => assert.ok(completed, JSON.stringify(model.failures)),
      timeout,
    );
  const idle = () =>
    eventually(readChat, (chat) => assert.equal(chat.status, "idle"), timeout);
  const call = (responseId, tool, args) =>
    model.reply({ responseId, calls: [{ ...tool, arguments: args }] });

  await idle();
  const original = await settingsWire();
  const setupArgs = { operationId: randomUUID(), configuration };
  call("council-mcp-first", setup, setupArgs);
  const retry = call("council-mcp-retry", setup, setupArgs);
  const changed = call("council-mcp-conflict", setup, {
    ...setupArgs,
    configuration: {
      ...configuration,
      args: [...configuration.args, "changed"],
    },
  });
  const configured = model.reply({ text: "The release MCP is configured." });
  assert.equal(
    (
      await submit(
        "Configure the release status MCP with the supplied settings.",
      )
    ).status,
    "queued",
  );
  await complete(configured);
  const receipt = projectToolOutput(retry, "council-mcp-first-call-0");
  assert.deepEqual(
    projectToolOutput(changed, "council-mcp-retry-call-0"),
    receipt,
  );
  assert.match(
    modelOutput(configured, "council-mcp-conflict-call-0"),
    /different MCP configuration/u,
  );
  assert.deepEqual(receipt, {
    id: receipt.id,
    workerId,
    name: setupName,
    transport: "stdio",
    enabled: true,
  });
  const added = (await settingsWire()).filter(
    ({ id }) => !original.some((server) => server.id === id),
  );
  assert.equal(added.length, 1);
  assert.deepEqual(
    added.map(({ id, audience, scope, workerId }) => ({
      id,
      audience,
      scope,
      workerId,
    })),
    [{ id: receipt.id, audience: "chat", scope: "global", workerId }],
  );
  assert.ok(!JSON.stringify({ added, receipt }).includes(disposableCredential));
  await idle();

  // The model writes and runs this short-lived client with its normal shell.
  // The managed tool is also visible through Codex on the next turn.
  const script = call("council-mcp-script", command, scriptArguments);
  const finished = model.reply({
    text: "I retrieved the live release status.",
  });
  assert.equal(
    (
      await submit(
        "Write and run a short-lived script to read the release status.",
      )
    ).status,
    "queued",
  );
  await complete(finished);
  assert.ok(
    modelFunctions(script.request.input.tools).some(({ name }) =>
      name.endsWith(`${setupName}__release_status`),
    ),
    "The installed service is available in the next native turn",
  );
  assert.match(
    modelOutput(finished, "council-mcp-script-call-0"),
    new RegExp(discoveredValue, "u"),
  );
  await idle();

  await page.evaluate(async () =>
    (await import("/src/lib/api/settings.ts")).updateSettings({
      defaultCouncilPermissionProfileId: ":read-only",
    }),
  );
  const readOnly = model.reply({ text: "I can use the configured read tool." });
  await submit("List the tools available with my read-only Council default.");
  await complete(readOnly);
  const readOnlyTools = modelFunctions(readOnly.request.input.tools);
  assert.ok(
    readOnlyTools.some(({ name }) => name.endsWith("council_inventory")),
  );
  assert.ok(
    readOnlyTools.some(({ name }) =>
      name.endsWith(`${setupName}__release_status`),
    ),
  );
  assert.ok(
    readOnlyTools.every(({ name }) => !name.endsWith("council_mcp_setup")),
  );
  await idle();
  assert.deepEqual(model.failures, []);
  result.councilMcpSetup = {
    workerId,
    serverId: receipt.id,
    approvals: [...accepted.values()],
  };
  result.steps.push(
    "Council configured a Worker MCP once, retrieved authenticated data with a short-lived script, and respected the account read-only default",
  );
}
