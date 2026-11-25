import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { eventually } from "./full-worker.mjs";
import { modelFunctions } from "./task-model-provider.mjs";
import { projectToolOutput } from "./actual-council-project-creation.mjs";

const disposableCredential = "council-fixture-mcp-secret";
const discoveredValue = "release canary is healthy";
const setupName = "council_setup_fixture";
const timeout = 60_000;

function modelOutput(plan, callId) {
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
  const fixture = path.join(root, "council-setup-mcp.mjs");
  await writeFile(
    fixture,
    `import { createInterface } from "node:readline";
const tools = [{
  name: "release_status",
  description: "Return the current release status",
  inputSchema: { type: "object" },
}];
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === "initialize") {
    if (process.env.COUNCIL_SETUP_CREDENTIAL !== ${JSON.stringify(disposableCredential)}) {
      process.exit(1);
    }
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "council-setup-fixture", version: "1" },
    };
  } else if (request.method === "tools/list") {
    result = { tools };
  } else if (request.method === "tools/call" && request.params.name === "release_status") {
    result = { content: [{ type: "text", text: ${JSON.stringify(discoveredValue)} }] };
  }
  const failure = { code: -32601, message: "Unknown fixture method" };
  console.log(JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    ...(result ? { result } : { error: failure }),
  }));
}
`,
  );
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
  const configuration = {
    name: setupName,
    transport: "stdio",
    command: process.execPath,
    args: [fixture],
    environment: { COUNCIL_SETUP_CREDENTIAL: disposableCredential },
  };
  const setupArgs = { operationId: randomUUID(), configuration };
  call("council-mcp-first", setup, setupArgs);
  const retry = call("council-mcp-retry", setup, setupArgs);
  const changed = call("council-mcp-conflict", setup, {
    ...setupArgs,
    configuration: { ...configuration, args: [fixture, "changed"] },
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
  const sdk = createRequire(
    new URL("../../tests/reference-node-worker/package.json", import.meta.url),
  );
  const sdkModule = (name) =>
    JSON.stringify(
      pathToFileURL(sdk.resolve(`@modelcontextprotocol/sdk/client/${name}`))
        .href,
    );
  const client = [
    `import { Client } from ${sdkModule("index.js")};`,
    `import { StdioClientTransport } from ${sdkModule("stdio.js")};`,
    'const client = new Client({ name: "council-script", version: "1" });',
    "try {",
    `  await client.connect(new StdioClientTransport(${JSON.stringify({
      command: process.execPath,
      args: [fixture],
      env: { COUNCIL_SETUP_CREDENTIAL: disposableCredential },
    })}));`,
    '  const result = await client.callTool({ name: "release_status" });',
    '  if (result.isError) throw new Error("MCP release status failed");',
    "  console.log(result.content[0].text);",
    "} finally {",
    "  await client.close();",
    "}",
  ].join("\n");
  const script = call("council-mcp-script", command, {
    cmd: [
      "set -e",
      'fixture_script=$(mktemp "$PWD/council-mcp-client.XXXXXX")',
      "trap 'rm -f -- \"$fixture_script\"' EXIT",
      "cat >\"$fixture_script\" <<'COUNCIL_MCP_SCRIPT'",
      client,
      "COUNCIL_MCP_SCRIPT",
      `'${process.execPath.replaceAll("'", "'\\''")}' --input-type=module < "$fixture_script"`,
    ].join("\n"),
    login: false,
    max_output_tokens: 1000,
  });
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
    /release canary is healthy/u,
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
