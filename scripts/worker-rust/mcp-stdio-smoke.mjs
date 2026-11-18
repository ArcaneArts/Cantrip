// The real native MCP child against the existing authenticated worker broker.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { CantripMcpBroker } from "../../cantrip_worker/src/mcp/broker.ts";
import { CodexRpcClient } from "../../cantrip_worker/src/codex/rpc-client.ts";

const { values } = parseArgs({
  options: { worker: { type: "string" }, codex: { type: "string" } },
});
assert.ok(values.worker);
const requireWorker = createRequire(
  new URL("../../cantrip_worker/package.json", import.meta.url),
);
const { Client } = await import(
  requireWorker.resolve("@modelcontextprotocol/sdk/client/index.js")
);
const { StdioClientTransport } = await import(
  requireWorker.resolve("@modelcontextprotocol/sdk/client/stdio.js")
);
const root = await mkdtemp(path.join(tmpdir(), "cantrip-native-mcp-"));
const workerId = "worker";
const claims = {
  ownerId: "owner",
  chatId: "chat",
  workerId,
  contextKind: "project",
  projectId: "project",
  worktreeId: "worktree",
  rootKind: "git-worktree",
  scratchRootId: null,
  permissionProfileId: ":workspace-write",
  allowedOperations: ["context.get"],
};
const connected = [];
let executions = 0;
const broker = new CantripMcpBroker(
  {
    dataDirectory: root,
    serverUrl: "https://example.invalid",
    token: "fixture",
    workerId,
  },
  {
    execute: async (binding, request) => {
      assert.deepEqual(request, { operation: "context.get", arguments: {} });
      assert.equal(binding.executionLaneId, "fixture-active-lane");
      executions++;
      return {
        summary: "Authorized native fixture context.",
        worktreeId: binding.worktreeId,
        data: {
          worker: { id: workerId, name: "Worker", online: true },
          context: {
            chatId: binding.chatId,
            executionLaneId: binding.executionLaneId,
            permissionProfileId: binding.permissionProfileId,
            projectId: binding.projectId,
            rootKind: binding.rootKind,
            terminalId: null,
            workerId,
            worktreeId: binding.worktreeId,
            worktreeMode: "agent-managed",
          },
          binding: {
            status: "read-only",
            mutationReady: false,
            staleClaims: [],
            recoveryInstruction: "Select an authorized profile for mutations.",
            expiresAt: binding.expiresAt,
          },
        },
      };
    },
  },
);

function host(native, connection, profile) {
  const command = native ? path.resolve(values.worker) : process.execPath;
  const args = native
    ? ["mcp"]
    : ["--import", "tsx", path.resolve("cantrip_worker/src/mcp/stdio.ts")];
  const transport = new StdioClientTransport({
    command,
    args: [...args, "--connection", connection],
    env: { PATH: "/usr/bin:/bin", CANTRIP_MCP_PROFILE: profile },
    stderr: "pipe",
  });
  const client = new Client({ name: "cantrip-native-mcp-test", version: "1" });
  connected.push(client);
  return { client, transport };
}
async function open(native, connection, profile) {
  const { client, transport } = host(native, connection, profile);
  await client.connect(transport);
  return client;
}
async function probeBundledCodex(connection) {
  await mkdir(path.join(root, "codex"));
  const child = spawn(path.resolve(values.codex), ["app-server"], {
    cwd: root,
    env: {
      HOME: root,
      CODEX_HOME: path.join(root, "codex"),
      PATH: "/usr/bin:/bin",
    },
    stdio: "pipe",
  });
  const closed = once(child, "close");
  const client = new CodexRpcClient(child, 10_000);
  const request = async (method, params) => {
    const reply = await client.request(method, params);
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    return reply.result;
  };
  try {
    await request("initialize", {
      clientInfo: { name: "cantrip-native-mcp-fixture", version: "1" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized");
    const { thread } = await request("thread/start", {
      cwd: root,
      model: "gpt-5",
      approvalPolicy: "never",
      sandbox: "read-only",
      config: {
        mcp_servers: {
          cantrip: {
            command: path.resolve(values.worker),
            args: ["mcp", "--connection", connection],
            enabled_tools: ["context_get"],
            required: true,
          },
        },
      },
    });
    const catalog = await request("mcpServerStatus/list", {
      threadId: thread.id,
    });
    const managed = catalog.data.find(({ name }) => name === "cantrip");
    assert.ok(managed);
    assert.ok(Object.hasOwn(managed.tools, "context_get"));
  } finally {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    try {
      child.stdin.end();
      await closed;
    } finally {
      clearTimeout(timer);
    }
  }
}
const call = (client, name, args, options) =>
  client.callTool({ name, arguments: args }, undefined, {
    timeout: 5_000,
    ...options,
  });
let comparisons = 0;
function same(actual, expected) {
  assert.deepEqual(actual, expected);
  comparisons++;
}
let server;
try {
  await broker.start();
  const session = broker.createSession(claims);
  if (values.codex) await probeBundledCodex(session.connectionPath);
  const native = await open(true, session.connectionPath, "ide");
  const reference = await open(false, session.connectionPath, "ide");
  function requestSummary(reply) {
    return reply.content[0].text;
  }
  assert.match(
    requestSummary(await call(native, "context_get", {})),
    /no active execution binding/,
  );
  assert.equal(executions, 0);
  const active = broker.activateSession({
    ...claims,
    executionLaneId: "fixture-active-lane",
  });
  assert.equal(typeof active, "function");
  same(
    await call(native, "context_get", {}),
    await call(reference, "context_get", {}),
  );
  assert.equal(executions, 2);
  active();
  assert.match(
    requestSummary(await call(native, "context_get", {})),
    /no active execution binding/,
  );

  const standalone = broker.createSession({
    ...claims,
    chatId: "scratch-chat",
    contextKind: "standalone",
    projectId: null,
    worktreeId: null,
    rootKind: null,
    scratchRootId: "scratch",
    allowedOperations: ["tool.help", "web.search", "web.read"],
  });
  const profiles = [
    [native, reference, "worktree_create"],
    [
      await open(true, standalone.connectionPath, "standalone-web"),
      await open(false, standalone.connectionPath, "standalone-web"),
      "web_search",
    ],
  ];
  for (const [rust, node, tool] of profiles) {
    const { version, ...nativeIdentity } = rust.getServerVersion();
    const { version: _referenceVersion, ...referenceIdentity } =
      node.getServerVersion();
    const built = JSON.parse(
      execFileSync(path.resolve(values.worker), ["--version"], {
        encoding: "utf8",
      }),
    );
    same(version, built.version);
    same(nativeIdentity, referenceIdentity);
    same(rust.getInstructions(), node.getInstructions());
    same(rust.getServerCapabilities(), node.getServerCapabilities());
    same(await rust.listTools(), await node.listTools());
    for (const [name, args] of [
      ["tool_help", { tool }],
      ["tool_help", { toolName: tool }],
      ["tool_help", {}],
      ["tool_help", { tool, toolName: "web_read" }],
      ["tool_help", { tool: "not-a-tool" }],
      ["tool_help", { tool: "worktree_create" }],
      ["web_read", {}],
      [
        "web_search",
        {
          query: "topic",
          includeDomains: ["Example.org"],
          excludeDomains: ["example.org"],
        },
      ],
      ["context_get", { unexpected: true }],
      ["unknown_tool", {}],
    ])
      same(await call(rust, name, args), await call(node, name, args));
  }

  // Controlled HTTP timing proves stdio cancellation closes the actual broker
  // request while another tool on the same child remains responsive.
  const bindingId = randomUUID();
  const credential = "fixture_" + "X".repeat(32);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  let arrived = Promise.withResolvers();
  let aborted = Promise.withResolvers();
  server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer " + credential);
    if (request.url === `/v1/bindings/${bindingId}`) {
      response.end(
        JSON.stringify({ protocolVersion: 1, bindingId, expiresAt }),
      );
      return;
    }
    const buffers = [];
    for await (const chunk of request) buffers.push(chunk);
    const { request: operation } = JSON.parse(Buffer.concat(buffers));
    assert.equal(request.url, "/v1/execute");
    if (operation.operation === "task.wait") {
      response.once("close", () => aborted.resolve());
      arrived.resolve();
    } else {
      assert.equal(operation.operation, "context.get");
      response.writeHead(200, { "content-length": 524_289 });
      response.end(Buffer.alloc(524_289, 32));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const fixture = path.join(root, "private.json");
  const document = {
    protocolVersion: 1,
    endpoint: `http://127.0.0.1:${server.address().port}`,
    bindingId,
    credential,
    expiresAt,
  };
  await writeFile(fixture, JSON.stringify(document), { mode: 0o600 });
  const cancellable = await open(true, fixture, "ide");
  const cancellation = new AbortController();
  const waiting = call(
    cancellable,
    "task_wait",
    { taskIds: [randomUUID()], timeoutMs: 0 },
    { signal: cancellation.signal },
  );
  const rejected = assert.rejects(waiting, /cancelled/i);
  await Promise.race([
    arrived.promise,
    rejected.then(() => {
      throw new Error("Broker never received task.wait.");
    }),
  ]);
  assert.ok(
    (await call(cancellable, "tool_help", { tool: "task_wait" }))
      .structuredContent,
  );
  cancellation.abort(new Error("cancelled"));
  await rejected;
  const timer = setTimeout(
    () => aborted.reject(new Error("Broker socket remained open.")),
    5_000,
  );
  try {
    await aborted.promise;
  } finally {
    clearTimeout(timer);
  }
  assert.match(
    requestSummary(await call(cancellable, "context_get", {})),
    /response is too large/,
  );

  for (const [name, value] of [
    [
      "wrong-binding",
      { ...document, expiresAt: new Date(Date.now() + 30_000).toISOString() },
    ],
    [
      "expired",
      { ...document, expiresAt: new Date(Date.now() - 1_000).toISOString() },
    ],
  ]) {
    const file = path.join(root, name);
    await writeFile(file, JSON.stringify(value), { mode: 0o600 });
    await assert.rejects(open(true, file, "ide"));
  }
  if (process.platform !== "win32") {
    const link = path.join(root, "symlink");
    await symlink(fixture, link);
    await assert.rejects(open(true, link, "ide"));
  }
  console.log(
    JSON.stringify({
      status: "passed",
      comparisons,
      bindingLifecycle: true,
      noNodeOnNativePath: true,
      bundledCodex: Boolean(values.codex),
      concurrentCalls: true,
      cancelledBrokerRequest: true,
      boundedResponse: true,
      invalidConnectionRefused: true,
    }),
  );
} finally {
  await Promise.allSettled(connected.map((client) => client.close()));
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await broker.close();
  await rm(root, { recursive: true, force: true });
}
