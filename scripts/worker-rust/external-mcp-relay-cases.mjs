import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { on, once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
  decodeWorkerLinkFrame,
  encodeWorkerLinkFrame,
} from "../../packages/protocol/dist/worker-link.js";

import {
  authorizeWorker,
  eventually,
  protection,
  stageFixtureCodegraph,
} from "./external-mcp-acceptance-fixture.mjs";

const WebSocket = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("ws");
const relay = "/api/external-mcp/hosted/relay";
export async function verifyHostedRelay({
  binary,
  codex,
  bundledCodex,
  codegraphDistribution,
  directory,
  env,
  server,
  owner,
  ownerId,
  password,
  unrelated,
  outsideScope,
  outsideAccount,
  integrations,
  request,
  connectMcp,
  transport,
  verifyHttps,
  setLocalEnabled,
  verifyApp,
}) {
  const workerId = randomUUID();
  const projectId = randomUUID();
  const workerDirectory = path.join(directory, "relay-worker");
  const ownerVisit = (method, route, status, json) =>
    owner.visit("hosted relay", method, route, { status, json });
  const enrollment = await ownerVisit(
    "POST",
    "/api/workers/enrollment-codes",
    201,
    { label: "Hosted MCP relay worker" },
  );
  const codegraphHome = await stageFixtureCodegraph({
    distribution: codegraphDistribution,
    directory,
    workerDirectory,
  });
  const sockets = new Set();
  let worker;
  let exit;
  let client;

  async function startWorker(enrollmentCode) {
    const workerEnv = { ...env };
    delete workerEnv.CANTRIP_EXTERNAL_MCP_BRIDGE_KEY;
    worker = spawn(path.resolve(binary), ["--shutdown-on-stdin-close"], {
      cwd: directory,
      env: {
        ...workerEnv,
        CANTRIP_WORKER_DATA_DIR: workerDirectory,
        CANTRIP_WORKER_ID: workerId,
        CANTRIP_SERVER_URL: server.origin,
        CANTRIP_EXTERNAL_MCP_FIXTURE_SECRET: "owned test environment marker",
        ...(codex && !bundledCodex
          ? { CANTRIP_CODEX_BIN: path.resolve(codex) }
          : {}),
        ...(codegraphHome ? { HOME: codegraphHome } : {}),
        ...(enrollmentCode
          ? { CANTRIP_WORKER_ENROLLMENT_CODE: enrollmentCode }
          : {}),
      },
      stdio: ["pipe", "ignore", "ignore"],
    });
    exit = once(worker, "close");
    await eventually(async () => {
      await ownerVisit("GET", `/api/workers/${workerId}/version`, 200);
    });
  }

  async function stopWorker() {
    if (!worker) return;
    worker.stdin.end();
    const timer = setTimeout(() => worker.kill("SIGKILL"), 10_000);
    try {
      assert.deepEqual(await exit, [0, null]);
    } finally {
      clearTimeout(timer);
      worker = undefined;
    }
  }

  const open = (credential, id, status = 201) =>
    request(relay, credential, { projectId: id }, status);
  const newIntegration = (account, projects) =>
    account.visit("relay integration", "POST", integrations, {
      status: 201,
      json: {
        label: "Hosted MCP relay fixture",
        permissions: { projects, scopes: ["projects-read", "placements-read"] },
        expiresInSeconds: 240,
      },
    });

  async function connectSession(credential, sessionId) {
    const origin = server.origin.replace(/^http/u, "ws");
    const socket = new WebSocket(origin + relay + "/" + sessionId, {
      headers: { authorization: `Bearer ${credential}` },
      handshakeTimeout: 10_000,
    });
    // The awaited socket operations below report errors to the assertions.
    socket.on("error", () => {});
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const ready = once(socket, "message", {
      signal: AbortSignal.timeout(10_000),
    });
    const [announcement, binary] = await ready;
    assert.equal(binary, false);
    assert.equal(announcement.toString(), "cantrip-external-mcp-relay-ready");
    return socket;
  }

  async function startChannel(credential, opened) {
    const { session, grant } = opened;
    const socket = await connectSession(credential, session.sessionId);
    const route = {
      protocolVersion: 1,
      sessionId: session.sessionId,
      routeGeneration: session.routeGeneration,
      effectiveRoute: "relay",
      channel: { channelId: randomUUID(), connectionId: randomUUID() },
      lane: "stream",
    };
    const incoming = on(socket, "message", {
      close: ["close"],
      signal: AbortSignal.timeout(10_000),
    });
    const next = async () => {
      const { value, done } = await incoming.next();
      assert.equal(
        done,
        false,
        "The WorkerLink socket closed before the next frame",
      );
      const [frame] = value;
      return decodeWorkerLinkFrame(frame).header;
    };
    const accepted = next();
    socket.send(
      encodeWorkerLinkFrame(
        {
          ...route,
          kind: "open",
          sequence: 0,
          openNonce: randomUUID(),
          channelKind: "reliable-stream",
          grant,
          initialCreditBytes: 64 * 1024,
        },
        new Uint8Array(),
      ),
    );
    const reply = await accepted;
    assert.equal(reply.kind, "accept", JSON.stringify(reply));
    return { socket, route, next };
  }

  try {
    await startWorker(enrollment.code);
    await authorizeWorker({
      ownerVisit,
      workerId,
      ownerId,
      password,
      workload: Boolean(codex),
    });
    await ownerVisit("POST", "/api/projects/from-folder", 202, {
      id: projectId,
      workerId,
      nameProtection: protection,
    });
    await eventually(async () => {
      const job = await ownerVisit(
        "GET",
        `/api/projects/${projectId}/folder-setup`,
        200,
      );
      assert.equal(job.state, "succeeded", JSON.stringify(job.error));
    });

    const selected = { kind: "selected", projectIds: [projectId] };
    const first = await newIntegration(owner, selected);
    const foreign = await newIntegration(unrelated, { kind: "all" });
    await open(null, projectId, 401);
    await open(first.credential, outsideScope, 404);
    await open(first.credential, outsideAccount, 404);
    await open(foreign.credential, projectId, 404);
    await request(
      relay,
      first.credential,
      { projectId, tool: "agent_create" },
      403,
    );

    const credentialFile = path.join(directory, "relay.credential");
    const callWorker = async (credential) => {
      await client?.close();
      await writeFile(credentialFile, credential + "\n", { mode: 0o600 });
      client = await connectMcp(credentialFile);
      assert.ok(
        (await client.listTools()).tools.some(
          ({ name }) => name === "worker_context",
        ),
      );
      const result = await client.callTool({
        name: "worker_context",
        arguments: { projectId },
      });
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      assert.equal(result.structuredContent.projectId, projectId);
      assert.equal(result.structuredContent.workerId, workerId);
      assert.equal(result.structuredContent.transport, transport);
      return result.structuredContent.processGeneration;
    };
    if (verifyHttps) {
      const grant = await newIntegration(owner, selected);
      await verifyHttps({
        owner,
        unrelated,
        grant,
        projectId,
        workerId,
        revoke: () =>
          ownerVisit("DELETE", `${integrations}/${grant.integration.id}`, 200),
        startChannel,
        open,
      });
    }
    if (codex) {
      const { verifyOrchestration } =
        await import("./external-mcp-orchestration-cases.mjs");
      const integration = await ownerVisit("POST", integrations, 201, {
        label: "External orchestration fixture",
        permissions: {
          projects: selected,
          scopes: ["chats-read", "chats-write", "tasks-read", "tasks-write"],
        },
        expiresInSeconds: 300,
      });
      await client?.close();
      await writeFile(credentialFile, integration.credential + "\n", {
        mode: 0o600,
      });
      client = await connectMcp(credentialFile);
      await verifyOrchestration({
        client,
        projectId,
        ownerVisit,
        eventually,
        connect: (operation, onSuppressed) =>
          connectMcp(credentialFile, operation, onSuppressed),
        setLocalEnabled,
        verifyApp,
      });
    }
    const { verifyInspection } =
      await import("./external-mcp-inspection-cases.mjs");
    const inspection = await ownerVisit("POST", integrations, 201, {
      label: "External inspection fixture",
      permissions: {
        projects: selected,
        scopes: ["files-read", "codegraph-read"],
      },
      expiresInSeconds: 300,
    });
    await request(
      relay,
      first.credential,
      { projectId, tool: "file_read" },
      403,
    );
    await request(
      relay,
      inspection.credential,
      { projectId: outsideScope, tool: "file_read" },
      404,
    );
    await request(
      relay,
      inspection.credential,
      { projectId: outsideAccount, tool: "file_read" },
      404,
    );
    await client?.close();
    await writeFile(credentialFile, inspection.credential + "\n", {
      mode: 0o600,
    });
    client = await connectMcp(credentialFile);
    await verifyInspection({
      client,
      workerDirectory,
      directory,
      projectId,
      ownerVisit,
      codegraphInstalled: Boolean(codegraphHome),
    });
    let execution;
    let verifyInterrupted;
    if (codex) {
      const { verifyExecution } =
        await import("./external-mcp-execution-cases.mjs");
      execution = await ownerVisit("POST", integrations, 201, {
        label: "External command fixture",
        permissions: {
          projects: selected,
          scopes: ["commands-execute", "cli-read", "cli-runs-write"],
        },
        expiresInSeconds: 300,
      });
      await request(
        relay,
        inspection.credential,
        { projectId, tool: "command_start" },
        403,
      );
      await request(
        relay,
        execution.credential,
        { projectId: outsideAccount, tool: "command_start" },
        404,
      );
      await client?.close();
      await writeFile(credentialFile, execution.credential + "\n", {
        mode: 0o600,
      });
      client = await connectMcp(credentialFile);
      const other = await ownerVisit("POST", integrations, 201, {
        label: "Separate command integration",
        permissions: { projects: selected, scopes: ["commands-execute"] },
        expiresInSeconds: 300,
      });
      const otherFile = path.join(directory, "other-command.credential");
      await writeFile(otherFile, other.credential + "\n", { mode: 0o600 });
      const otherClient = await connectMcp(otherFile);
      try {
        verifyInterrupted = await verifyExecution({
          client,
          directory,
          workerDirectory,
          projectId,
          ownerVisit,
          unrelated,
          otherClient,
          eventually,
        });
      } finally {
        await otherClient.close();
      }
    }
    const generation = await callWorker(first.credential);
    const bad = await open(first.credential, projectId);
    const badSession = relay + "/" + bad.session.sessionId;
    await request(badSession, null, null, 401);
    await request(badSession, foreign.credential, null, 404);
    const plaintext = await startChannel(first.credential, bad);
    const rejected = plaintext.next();
    plaintext.socket.send(
      encodeWorkerLinkFrame(
        {
          ...plaintext.route,
          kind: "data",
          sequence: 1,
          direction: "client-to-worker",
          payloadFormat: "external-mcp-v1",
        },
        Buffer.from("worker-context"),
      ),
    );
    let close = await rejected;
    if (close.kind === "credit") close = await plaintext.next();
    assert.equal(close.kind, "close");
    assert.equal(close.code, "protocol-error");
    plaintext.socket.close();

    const stale = await open(first.credential, projectId);
    await stopWorker();
    await eventually(() => open(first.credential, projectId, 409));
    await startWorker();
    assert.notEqual(await callWorker(first.credential), generation);
    if (verifyInterrupted) {
      await client?.close();
      await writeFile(credentialFile, execution.credential + "\n", {
        mode: 0o600,
      });
      client = await connectMcp(credentialFile);
      await verifyInterrupted(client);
    }
    await request(
      relay + "/" + stale.session.sessionId,
      first.credential,
      null,
      404,
    );

    const active = await startChannel(
      first.credential,
      await open(first.credential, projectId),
    );
    const disconnected = once(active.socket, "close", {
      signal: AbortSignal.timeout(10_000),
    });
    const rotation = await ownerVisit(
      "POST",
      `${integrations}/${first.integration.id}/rotate`,
      200,
      { expiresInSeconds: 240 },
    );
    await disconnected;
    await open(first.credential, projectId, 401);
    await callWorker(rotation.credential);

    const revoked = await startChannel(
      rotation.credential,
      await open(rotation.credential, projectId),
    );
    const revokedStream = once(revoked.socket, "close", {
      signal: AbortSignal.timeout(10_000),
    });
    const target = `${integrations}/${rotation.integration.id}`;
    await ownerVisit("DELETE", target, 200);
    await revokedStream;
    await ownerVisit("DELETE", target, 200);
    await open(rotation.credential, projectId, 401);
  } finally {
    for (const socket of sockets) socket.terminate();
    await client?.close();
    await stopWorker();
  }
}
