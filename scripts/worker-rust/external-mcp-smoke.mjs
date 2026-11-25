import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { fixtureEnvironment, startServer } from "../server-rust/process.mjs";

const { values } = parseArgs({
  options: {
    server: { type: "string" },
    worker: { type: "string" },
    codex: { type: "string" },
  },
});
assert.ok(
  values.server && values.worker,
  "Pass --server and --worker binaries.",
);
const worker = path.resolve(values.worker);
const requireSdk = createRequire(
  new URL("../../tests/reference-node-worker/package.json", import.meta.url),
);
const sdk = (file) =>
  import(requireSdk.resolve(`@modelcontextprotocol/sdk/client/${file}.js`));
const [
  { Client },
  { StdioClientTransport },
  { StreamableHTTPClientTransport },
] = await Promise.all([sdk("index"), sdk("stdio"), sdk("streamableHttp")]);

const directory = await mkdtemp(path.join(tmpdir(), "cantrip-external-mcp-"));
const env = fixtureEnvironment(directory);
const cases = [];
const rpc = (method, params, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});
const names = [
  "workspace_list",
  "project_list",
  "chat_list",
  "agent_list",
  "task_list",
  "placement_list",
  "worker_list",
  "worker_context",
  "agent_create",
  "agent_read",
  "chat_send",
  "chat_read",
  "chat_wait",
  "task_create",
  "task_start",
  "task_status",
  "task_wait",
  "directory_list",
  "file_metadata",
  "file_read",
  "file_search",
  "codegraph_status",
  "codegraph_query",
  "command_start",
  "command_status",
  "command_output",
  "command_wait",
  "command_cancel",
  "cantrip_cli",
  "cantrip_cli_run",
];
const headers = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
const post = (url, body, moreHeaders = {}) =>
  fetch(url, {
    method: "POST",
    headers: { ...headers, ...moreHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
const expectStatus = async (response, status) => {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return text ? JSON.parse(text) : null;
};
const startChild = (command, args) => {
  const child = spawn(command, args, {
    cwd: directory,
    env,
    stdio: "pipe",
    windowsHide: true,
  });
  const closed = once(child, "close");
  return {
    child,
    async close() {
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      try {
        child.stdin.end();
        await closed;
      } finally {
        clearTimeout(timer);
      }
    },
  };
};
const inspect = async (transport, projects, workerId) => {
  const client = new Client({ name: "external-mcp-smoke", version: "1" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      names,
    );
    assert.deepEqual(
      tools
        .filter((tool) => !tool.annotations.readOnlyHint)
        .map(({ name }) => name),
      [
        "agent_create",
        "chat_send",
        "task_create",
        "task_start",
        "command_start",
        "command_cancel",
        "cantrip_cli_run",
      ],
    );
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      return result.structuredContent;
    };
    const workspaces = await call("workspace_list");
    assert.ok(workspaces.entries.some(({ name }) => name === "Default"));
    const { entries, nextCursor } = await call("project_list", { limit: 1 });
    assert.equal(entries[0].id, projects[0]);
    assert.equal(entries[0].labelProtected, true);
    assert.ok(nextCursor);
    const next = await call("project_list", { cursor: nextCursor, limit: 1 });
    assert.equal(next.entries[0].id, projects[1]);
    assert.equal(next.nextCursor, null);
    const workers = await call("worker_list");
    const offline = workers.entries.find(({ id }) => id === workerId);
    assert.equal(offline.online, false);
    assert.match(offline.unavailableReason, /offline/);
    const args = { projectId: projects[0] };
    for (const name of ["agent_list", "chat_list", "task_list"]) {
      assert.deepEqual((await call(name, args)).entries, []);
    }
    const placements = await call("placement_list", args);
    assert.ok(
      placements.entries.some(
        ({ availability }) => availability === "worker-offline",
      ),
    );
    const absent = await client.callTool({
      name: "agent_list",
      arguments: { projectId: randomUUID() },
    });
    assert.equal(absent.isError, true);
  } finally {
    await client.close();
  }
};

let server, bridge;
try {
  server = await startServer(
    path.resolve(values.server),
    [
      "--port",
      "0",
      "--external-mcp-local-port",
      "0",
      "--shutdown-on-stdin-close",
    ],
    { cwd: directory, env },
  );
  const control = server.events.find(
    ({ event }) => event === "server.external-mcp.listening",
  )?.origin;
  assert.ok(control);
  const controlPath = "/api/external-mcp/discovery";
  const discovery = { tool: "project_list", arguments: {} };
  await expectStatus(await post(server.origin + controlPath, discovery), 404);
  assert.equal(
    (
      await post(control + controlPath, discovery, {
        origin: "https://invalid.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await post(control + controlPath, discovery, {
        forwarded: "for=192.0.2.10",
      })
    ).status,
    403,
  );

  const enrollment = await expectStatus(
    await post(server.origin + "/api/workers/enrollment-codes", {
      label: "Offline fixture",
    }),
    201,
  );
  const workerId = "external-mcp-offline";
  await expectStatus(
    await post(server.origin + "/api/internal/workers/enroll", {
      code: enrollment.code,
      heartbeat: {
        workerId,
        name: "Offline fixture",
        platform: process.platform,
        architecture: process.arch,
        codexVersion: null,
        startedAt: new Date().toISOString(),
        managedFolders: { create: true, remove: true },
      },
    }),
    201,
  );
  const projects = [randomUUID(), randomUUID()].sort();
  for (const id of projects) {
    await expectStatus(
      await post(server.origin + "/api/projects/from-folder", {
        id,
        workerId,
        nameProtection: {
          classification: { recordKind: "project" },
          protectedLabel: {
            formatVersion: 1,
            keyRevision: 1,
            envelope: {
              version: 1,
              algorithm: "AES-256-GCM",
              keyRevision: 1,
              nonce: Buffer.alloc(12).toString("base64url"),
              ciphertext: Buffer.alloc(32).toString("base64url"),
            },
          },
        },
      }),
      202,
    );
  }

  const workerArgs = ["external-mcp", "--server", control];
  await inspect(
    new StdioClientTransport({
      command: worker,
      args: workerArgs,
      cwd: directory,
    }),
    projects,
    workerId,
  );
  cases.push("SDK stdio discovery");

  bridge = startChild(worker, [...workerArgs, "--http-port", "0"]);
  const lines = createInterface({ input: bridge.child.stderr });
  const [line] = await once(lines, "line", {
    signal: AbortSignal.timeout(10_000),
  });
  const endpoint = line.match(/http:\/\/127\.0\.0\.1:\d+\/mcp$/)?.[0];
  assert.ok(endpoint, line);
  await inspect(
    new StreamableHTTPClientTransport(new URL(endpoint)),
    projects,
    workerId,
  );
  const ping = rpc("ping", {});
  assert.equal(
    (await post(endpoint, ping, { origin: "https://invalid.example" })).status,
    403,
  );
  assert.equal(
    (await post(endpoint, ping, { "x-forwarded-for": "192.0.2.10" })).status,
    403,
  );
  assert.equal(
    (
      await expectStatus(
        await post(endpoint, ping, { "mcp-protocol-version": "1900-01-01" }),
        400,
      )
    ).error.code,
    -32022,
  );

  const modern = "2026-07-28";
  const modernParams = {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": modern,
      "io.modelcontextprotocol/clientInfo": {
        name: "modern-smoke",
        version: "1",
      },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  };
  const modernHeaders = {
    "mcp-protocol-version": modern,
    "mcp-method": "server/discover",
  };
  const discover = await expectStatus(
    await post(endpoint, rpc("server/discover", modernParams), modernHeaders),
    200,
  );
  assert.equal(discover.result.resultType, "complete");
  assert.ok(discover.result.supportedVersions.includes(modern));
  const call = rpc("tools/call", { ...modernParams, name: "project_list" });
  const callHeaders = {
    ...modernHeaders,
    "mcp-method": "tools/call",
    "mcp-name": "project_list",
  };
  assert.equal(
    (await expectStatus(await post(endpoint, call, callHeaders), 200)).result
      .structuredContent.entries.length,
    2,
  );
  assert.equal(
    (
      await expectStatus(
        await post(endpoint, call, {
          ...callHeaders,
          "mcp-name": "worker_list",
        }),
        400,
      )
    ).error.code,
    -32020,
  );
  cases.push(
    "SDK Streamable HTTP, modern discovery, headers and loopback isolation",
  );

  if (values.codex) {
    const { CodexRpcClient } =
      await import("../../tests/reference-node-worker/src/codex/rpc-client.ts");
    env.CODEX_HOME = path.join(directory, "codex");
    await mkdir(env.CODEX_HOME);
    const codex = startChild(path.resolve(values.codex), ["app-server"]);
    try {
      const client = new CodexRpcClient(codex.child, 15_000);
      const request = async (method, params) => {
        const response = await client.request(method, params);
        assert.equal(response.error, undefined, JSON.stringify(response.error));
        return response.result;
      };
      await request("initialize", {
        clientInfo: { name: "external-mcp-smoke", version: "1" },
        capabilities: { experimentalApi: true },
      });
      client.notify("initialized");
      const { thread } = await request("thread/start", {
        cwd: directory,
        approvalPolicy: "never",
        sandbox: "read-only",
        config: {
          mcp_servers: {
            cantrip_external: {
              command: worker,
              args: workerArgs,
              required: true,
            },
          },
        },
      });
      const { data } = await request("mcpServerStatus/list", {
        threadId: thread.id,
      });
      assert.ok(
        data.find(({ name }) => name === "cantrip_external")?.tools
          .project_list,
      );
      cases.push("bundled Codex MCP tool discovery");
    } finally {
      await codex.close();
    }
  }
  console.log(JSON.stringify({ cases, result: "passed" }));
} finally {
  await bridge?.close();
  await server?.close();
  await rm(directory, { recursive: true, force: true });
}
