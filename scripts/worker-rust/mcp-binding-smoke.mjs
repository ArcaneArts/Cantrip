// Native stdio -> native worker broker -> authenticated Rust server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { buildRustExample } from "../server-rust/build.mjs";
import {
  settingsHttpFixture,
  settingsChat as chatId,
  settingsProject as projectId,
  settingsTree as worktreeId,
  settingsWorker as workerId,
} from "../server-rust/native-settings-http-fixture.mjs";
import { literal } from "../server-rust/project-target-state.mjs";

const { values } = parseArgs({
  options: { worker: { type: "string" }, fixture: { type: "string" } },
});
assert.ok(values.worker && values.fixture, "Supply the two native binaries.");
const worker = path.resolve(values.worker);
const requireWorker = createRequire(
  new URL("../../cantrip_worker/package.json", import.meta.url),
);
const { Client } = await import(
  requireWorker.resolve("@modelcontextprotocol/sdk/client/index.js")
);
const { StdioClientTransport } = await import(
  requireWorker.resolve("@modelcontextprotocol/sdk/client/stdio.js")
);
const root = await mkdtemp(path.join(tmpdir(), "cantrip-native-mcp-binding-"));
let server, child, closed, client, lines;
try {
  server = await settingsHttpFixture({
    kind: "rust",
    profile: "none",
    root,
    databaseMode: "pglite",
    executable:
      process.env.CANTRIP_RUST_SERVER_BINARY ??
      (await buildRustExample("http-sql-fixture")),
    result: { observations: [] },
    liveSqlFixture: true,
    configure: () => [
      `UPDATE chats SET status='running',worktree_mode='agent-managed',permission_profile_id=':workspace' WHERE id=${literal(chatId)}`,
      `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES('mcp-lane',${literal(chatId)},${literal(worktreeId)},${literal(workerId)},'agent',false,'Native MCP fixture','active',now(),'settings-runtime')`,
    ],
  });
  const url = server.fixture.server.origin;
  child = spawn(path.resolve(values.fixture), [], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  closed = once(child, "close");
  lines = createInterface({ input: child.stdout });
  const replies = lines[Symbol.asyncIterator]();
  const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
  send({
    directory: root,
    credential: server.credential,
    owner: server.owner,
    serverId: server.serverId,
    worker: workerId,
    url,
  });
  async function ask(op, fields = {}) {
    send({ op, ...fields });
    const next = await replies.next();
    assert.ok(!next.done, "Native broker fixture closed its response stream.");
    return JSON.parse(next.value);
  }
  async function expectResult(op, fields = {}) {
    const reply = await ask(op, fields);
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    return reply.result;
  }

  const claims = {
    ownerId: server.owner,
    workerId,
    chatId,
    projectId,
    worktreeId,
    contextKind: "project",
    rootKind: "git-worktree",
    scratchRootId: null,
    permissionProfileId: ":workspace",
    allowedOperations: ["context.get", "tool.help", "terminal.send"],
  };
  const lane = { ...claims, executionLaneId: "mcp-lane" };
  assert.match(
    (
      await ask("prepare", {
        worker,
        claims: { ...claims, ownerId: "other-owner" },
      })
    ).error,
    /different worker or owner/,
  );
  const attachment = await expectResult("prepare", { worker, claims });
  const { configuration } = attachment;
  const document = JSON.parse(await readFile(attachment.path, "utf8"));
  assert.deepEqual(configuration.enabled_tools, ["context_get", "tool_help"]);
  assert.deepEqual(configuration.args, [
    "mcp",
    "--connection",
    attachment.path,
  ]);
  assert.equal(configuration.command, worker);
  assert.equal(
    configuration.env.CANTRIP_MCP_CONNECTION_GENERATION,
    document.bindingId,
  );
  if (process.platform !== "win32") {
    assert.equal((await stat(attachment.path)).mode & 0o777, 0o600);
    assert.equal(
      (await stat(path.dirname(attachment.path))).mode & 0o777,
      0o700,
    );
  }
  assert.equal(new URL(document.endpoint).hostname, "127.0.0.1");
  async function request(route, options = {}, token = document.credential) {
    const response = await fetch(document.endpoint + route, {
      ...options,
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
    return { status: response.status, body: await response.json() };
  }
  const handshake = "/v1/bindings/" + document.bindingId;
  const direct = (operation, args) =>
    request("/v1/execute", {
      method: "POST",
      body: JSON.stringify({
        bindingId: document.bindingId,
        request: { operation, arguments: args },
      }),
    });
  assert.equal((await request(handshake, {}, "wrong")).status, 401);
  assert.deepEqual((await request(handshake)).body, {
    protocolVersion: 1,
    bindingId: document.bindingId,
    expiresAt: document.expiresAt,
  });

  client = new Client({ name: "cantrip-native-binding-test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: configuration.command,
      args: configuration.args,
      env: { PATH: "/usr/bin:/bin", ...configuration.env },
      stderr: "inherit",
    }),
  );
  const context = () =>
    client.callTool({ name: "context_get", arguments: {} }, undefined, {
      timeout: 5000,
    });
  const idle = await context();
  assert.equal(idle.isError, true);
  assert.match(idle.content[0].text, /no active execution binding/);
  for (const change of [
    { ownerId: "other-owner" },
    { projectId: "other-project" },
    { worktreeId: "other-root" },
    { permissionProfileId: ":read-only" },
  ]) {
    assert.equal(
      await expectResult("activate", { claims: { ...lane, ...change } }),
      null,
    );
  }
  const first = await expectResult("activate", { claims: lane });
  const proof = await context();
  assert.equal(proof.isError, undefined, JSON.stringify(proof));
  assert.equal(
    proof.structuredContent.data.context.executionLaneId,
    lane.executionLaneId,
  );
  assert.equal(proof.structuredContent.data.context.worktreeId, worktreeId);
  assert.equal(proof.structuredContent.data.binding.status, "read-only");
  assert.equal((await direct("terminal.send", {})).status, 403);
  assert.equal((await direct("context.get", { other: true })).status, 400);
  assert.equal(
    (await direct("tool.help", { tool: "context_get" })).status,
    200,
  );
  assert.equal(
    (await direct("tool.help", { toolName: "context_get" })).status,
    400,
  );

  const reattached = await expectResult("prepare", { worker, claims });
  assert.deepEqual(reattached, attachment);
  const second = await expectResult("activate", { claims: lane });
  assert.equal(await expectResult("release", { index: first }), false);
  assert.equal((await context()).structuredContent.data.context.chatId, chatId);

  await expectResult("owner", { owner: "switched-owner" });
  assert.equal((await request(handshake)).status, 401);
  assert.equal((await direct("context.get", {})).status, 401);
  await expectResult("owner", { owner: server.owner });

  // A valid-looking local binding for an absent chat reaches the real Rust
  // server once. Its rejection is latched for this activation.
  const missingClaims = {
    ...claims,
    chatId: "33333333-3333-4333-8333-333333333334",
  };
  const missing = await expectResult("prepare", {
    worker,
    claims: missingClaims,
  });
  const missingDocument = JSON.parse(await readFile(missing.path, "utf8"));
  await expectResult("activate", {
    claims: { ...missingClaims, executionLaneId: "missing-lane" },
  });
  const stale = async (operation) => {
    const response = await fetch(missingDocument.endpoint + "/v1/execute", {
      method: "POST",
      headers: {
        authorization: "Bearer " + missingDocument.credential,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        bindingId: missingDocument.bindingId,
        request: {
          operation,
          arguments: operation === "tool.help" ? { tool: "context_get" } : {},
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 409);
    return response.json();
  };
  const rejected = await stale("context.get");
  assert.equal(rejected.code, "stale-binding");
  assert.match(rejected.error, /chat context no longer exists.*Do not retry/);
  assert.deepEqual(await stale("tool.help"), rejected);

  assert.equal(await expectResult("release", { index: second }), true);
  assert.equal((await direct("context.get", {})).body.code, "inactive-binding");
  assert.equal(
    await expectResult("revoke", { bindingId: document.bindingId }),
    true,
  );
  assert.equal((await request(handshake)).status, 401);
  await assert.rejects(stat(attachment.path), { code: "ENOENT" });
  child.stdin.end();
  assert.deepEqual(await closed, [0, null]);
  await assert.rejects(stat(missing.path), { code: "ENOENT" });
  console.log(
    "Native MCP binding, stdio, and authenticated Rust server smoke passed.",
  );
} finally {
  try {
    await client?.close();
  } finally {
    lines?.close();
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill();
    try {
      await closed;
      await server?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
