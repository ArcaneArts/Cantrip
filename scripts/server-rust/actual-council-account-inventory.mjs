import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eventually } from "./full-worker.mjs";

export async function verifyCouncilAccountInventory({
  page,
  root,
  chatId,
  workerId,
  remoteWorkerId,
  model,
  tool,
  terminal,
  submit,
  idle,
  result,
}) {
  const credential = "private-disposable-council-mcp-value";
  const proof = path.join(root, "account-inventory-mcp-proof");
  const server = path.join(root, "account-inventory-mcp.mjs");
  await writeFile(
    server,
    `
    import { createInterface } from "node:readline";
    import { writeFileSync } from "node:fs";
    for await (const line of createInterface({ input: process.stdin })) {
      const frame = JSON.parse(line);
      if (frame.id === undefined) continue;
      if (frame.method === "initialize") {
        if (process.env.COUNCIL_MCP_FIXTURE !== ${JSON.stringify(credential)}) process.exit(1);
        writeFileSync(process.argv[2], "authenticated");
        console.log(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {
          protocolVersion: frame.params.protocolVersion, capabilities: { tools: {} },
          serverInfo: { name: "account-inventory-fixture", version: "1" },
        }}));
      } else if (frame.method === "tools/list") {
        console.log(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { tools: [
          { name: "release_status", description: "Read the release status", inputSchema: { type: "object" } },
        ] } }));
      } else {
        console.log(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Unknown method" } }));
      }
    }
  `,
  );
  const expected = await page.evaluate(
    async ({ workerId, remoteWorkerId, credential, server, proof, node }) => {
      const policy = await (
        await import("/src/lib/api/policies.ts")
      ).createPolicy({
        key: "council-release-evidence",
        name: "Private Council release evidence",
        summary: "Require release evidence.",
        bodyMarkdown:
          "Use the exact Council policy marker C-717 for release evidence.",
        enabled: true,
        mandatory: false,
        audience: "chat",
      });
      const { createGlobalMcpServer } = await import("/src/lib/api/mcp.ts");
      const configuration = {
        name: "release_inventory_fixture",
        transport: "stdio",
        command: node,
        args: [server, proof],
        environment: { COUNCIL_MCP_FIXTURE: credential },
      };
      const mcp = await createGlobalMcpServer(configuration, workerId, "chat");
      const remoteOnly = await createGlobalMcpServer(
        { ...configuration, name: "remote_inventory_fixture" },
        remoteWorkerId,
        "chat",
      );
      const settings = await window.folderRequest("/api/settings");
      const wireMcp = await window.folderRequest("/api/settings/mcp-servers");
      return {
        policyId: policy.id,
        mcpId: mcp.id,
        remoteMcpId: remoteOnly.id,
        modelId: settings.preferences.defaultCouncilModelId,
        wireMcp,
      };
    },
    {
      workerId,
      remoteWorkerId,
      credential,
      server,
      proof,
      node: process.execPath,
    },
  );
  assert.ok(expected.modelId);
  assert.ok(!JSON.stringify(expected.wireMcp).includes(credential));
  const sections = ["agents", "settings", "models", "policies", "tools"];
  const discovered = model.reply({
    responseId: "account-inventory",
    calls: sections.map((section) => ({ ...tool, arguments: { section } })),
  });
  const cli = model.reply({
    responseId: "account-inventory-cli",
    calls: [
      {
        ...terminal,
        arguments: {
          cmd: [
            "set -e",
            ...sections.map(
              (section) => `cantrip --json council inventory ${section}`,
            ),
          ].join("\n"),
          max_output_tokens: 5000,
        },
      },
    ],
  });
  const finish = model.reply({
    text: "I inspected the Council account inventory.",
  });
  assert.equal(
    (await submit("Inspect my Council account inventory and available tools."))
      .status,
    "queued",
  );
  await eventually(
    () => finish.entered,
    (outcome) => assert.ok(outcome),
    60_000,
  );
  const request = JSON.stringify(discovered.request.input);
  assert.ok(
    request.includes("C-717"),
    "global policy reached native inference",
  );
  assert.ok(
    request.includes("council-release-playbook"),
    "global skill reached native inference",
  );
  assert.ok(
    request.includes("release_status"),
    "the configured MCP server supplied an actual native tool",
  );
  assert.equal(await readFile(proof, "utf8"), "authenticated");

  function output(plan, call) {
    const item = plan.request.input.input.find(
      ({ type, call_id }) =>
        type === "function_call_output" && call_id === call,
    );
    assert.ok(item, `Codex received ${call}`);
    const value =
      typeof item.output === "string"
        ? item.output
        : item.output.map(({ text }) => text).join("\n");
    const offset = value.indexOf("\nOutput:\n");
    return offset === -1
      ? value
      : value.slice(offset + "\nOutput:\n".length).trim();
  }
  const rows = sections.map(
    (_, index) =>
      JSON.parse(output(cli, `account-inventory-call-${index}`)).data,
  );
  const shell = output(finish, "account-inventory-cli-call-0")
    .split(/\n(?=\{)/u)
    .map((line) => JSON.parse(line).data);
  assert.deepEqual(shell, rows);
  const [agents, settings, models, policies, tools] = rows;
  assert.ok(
    agents.entries.some(
      ({ id, title }) =>
        id === chatId && title === "Disposable Operations Agent",
    ),
  );
  assert.ok(
    settings.entries.some(
      ({ id, value }) =>
        id === "defaultCouncilModelId" && value === expected.modelId,
    ),
  );
  assert.ok(
    models.entries.some(
      ({ id, title, enabledRoutes }) =>
        id === expected.modelId &&
        title === "Disposable Council model" &&
        enabledRoutes === 1,
    ),
  );
  assert.deepEqual(
    policies.entries.find(({ id }) => id === expected.policyId),
    {
      id: expected.policyId,
      kind: "policy",
      title: "Private Council release evidence",
      key: "council-release-evidence",
    },
  );
  assert.deepEqual(
    tools.entries.find(({ id }) => id === expected.mcpId),
    {
      id: expected.mcpId,
      kind: "mcp-server",
      title: "release_inventory_fixture",
      transport: "stdio",
    },
  );
  assert.ok(tools.managedTools.includes("council_inventory"));
  assert.ok(tools.entries.every(({ id }) => id !== expected.remoteMcpId));
  assert.ok(!JSON.stringify({ request, rows, shell }).includes(credential));
  await idle();
  result.steps.push(
    "Council inherited account policy, skills, and authenticated Worker MCP and discovered account metadata in MCP and CLI without exposing credentials.",
  );
}
