// Production server and worker transports with a controlled opaque resource.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { WorkerLinkGateway } from "../../cantrip_worker/src/worker-link-gateway.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { sendHeartbeat } from "../../cantrip_worker/src/heartbeat.ts";
import {
  decodeWorkerLinkFrame,
  encodeWorkerLinkFrame,
} from "../../packages/protocol/dist/worker-link.js";
import { eventually } from "./full-worker.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import {
  productionClient,
  productionProcess,
} from "./production-server-process.mjs";
import { heartbeat } from "./security-fixtures.mjs";
import { tunnelRecord } from "./tunnel-record-fixture.mjs";

const WebSocket = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("ws");
const origin = "http://127.0.0.1:5173";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const frameKey = (header) => `${header.channel.channelId}:${header.sequence}`;

export class ProductionWorkerLinkFixture {
  constructor(options) {
    Object.assign(this, options);
    this.commands = [];
    this.background = [];
    this.channels = new Map();
    this.endpointFrames = new Map();
    this.relays = [];
    this.connections = 0;
    this.serverGenerations = [];
    this.disconnects = 0;
    this.adapterRevocations = [];
  }

  async start() {
    await mkdir(this.root, { recursive: true });
    if (
      this.database === "postgres" ||
      (this.runtime === "node" && this.database === "bundled-postgres")
    ) {
      this.pg = await postgresFixture(path.join(this.root, "postgres"));
      this.databaseUrl = await this.pg.database();
    }
    await this.startServer("initial");
    const code = await this.client.visit(
      "enrollment code",
      "POST",
      "/api/workers/enrollment-codes",
      { status: 201, json: { label: "Opaque relay benchmark" } },
    );
    this.heartbeat = {
      ...heartbeat,
      workerId: "alpha",
      name: "opaque worker",
      platform: "darwin",
    };
    const enrollment = await this.client.visit(
      "enroll",
      "POST",
      "/api/internal/workers/enroll",
      { status: 201, json: { code: code.code, heartbeat: this.heartbeat } },
    );
    this.workerConfig = {
      dataDirectory: path.join(this.root, "worker"),
      name: this.heartbeat.name,
      serverUrl: this.server.origin,
      enrollmentCode: null,
      replacement: null,
      token: enrollment.credential,
      tokenSource: "persisted",
      workerId: "alpha",
    };
    saveWorkerCredential({
      credential: enrollment.credential,
      dataDirectory: this.workerConfig.dataDirectory,
      serverUrl: this.workerConfig.serverUrl,
      workerId: "alpha",
    });
    await this.startWorker();
    return this;
  }

  async startWorker() {
    const connections = this.connections;
    this.workerGeneration = randomUUID();
    const workerGeneration = this.workerGeneration;
    this.gateway = new WorkerLinkGateway({
      ownerId: this.bootstrap.auth.currentUser.id,
      serverId: this.bootstrap.server.id,
      workerId: "alpha",
      workerProcessGeneration: this.workerGeneration,
    });
    const gateway = this.gateway;
    for (const kind of ["observations", "tunnel"])
      this.gateway.registerAdapter({
        kind,
        open: ({ channel, emit, grant }) => {
          const endpoint = {
            channelId: channel.channelId,
            grantId: grant.binding.grantId,
            emit,
            closed: false,
            credits: 0,
            writable: 0,
            incomingBytes: 0,
            incomingFrames: 0,
            incomingHash: createHash("sha256"),
          };
          this.channels.set(channel.channelId, endpoint);
          return {
            close: (code) => {
              endpoint.closed = true;
              endpoint.closeCode = code;
              endpoint.wake?.();
            },
            credit: (bytes) => {
              endpoint.credits += bytes;
              endpoint.wake?.();
            },
            carrierWritable: () => {
              endpoint.writable++;
              endpoint.wake?.();
            },
            write: (payload) => {
              endpoint.incomingBytes += payload.byteLength;
              endpoint.incomingFrames++;
              endpoint.incomingHash.update(payload);
              if (endpoint.echo)
                assert.equal(
                  emit.data(payload, "raw"),
                  true,
                  "Controlled echo has credit and carrier capacity",
                );
            },
          };
        },
        revoke: ({ grant }) => {
          this.adapterRevocations.push(grant.binding.grantId);
        },
      });
    let connection;
    const respond = (header, payload) => {
      const accepted = connection.sendWorkerLinkFrame(header, payload);
      if (accepted)
        this.endpointFrames.set(
          frameKey(header),
          digest(encodeWorkerLinkFrame(header, payload)),
        );
      return accepted;
    };
    respond.waitForCapacity = () => connection.waitForWorkerLinkCapacity();
    connection = new WorkerConnection(
      this.workerConfig,
      async (command) => {
        if (command.type === "worktree.observation.configure")
          return { accepted: true, paths: [] };
        if (command.type === "worker-link.identity.resolve")
          return {
            serverId: this.bootstrap.server.id,
            ownerId: this.bootstrap.auth.currentUser.id,
            workerId: "alpha",
            workerProcessGeneration: workerGeneration,
          };
        if (command.type.startsWith("worker-link.")) {
          this.commands.push(command.type);
          return gateway.handleCoordinatorCommand(command);
        }
        this.background.push(command.type);
        throw new Error(
          "Controlled endpoint does not implement " + command.type,
        );
      },
      undefined,
      undefined,
      () => {
        this.disconnects++;
        void gateway.revokeAll("endpoint-disconnected");
      },
      undefined,
      (serverGeneration) => {
        this.connections++;
        this.serverGenerations.push(serverGeneration);
      },
      {
        connectionGeneration: workerGeneration,
        handleWorkerLinkFrame: (header, payload) =>
          gateway.handleFrame(header, payload, respond),
      },
    );
    this.worker = connection;
    connection.start();
    await eventually(
      () => this.connections,
      (count) => assert.equal(count, connections + 1),
      60000,
    );
    await sendHeartbeat(this.workerConfig, this.heartbeat);
    return this;
  }

  async startServer(label, port = 0) {
    this.server = await productionProcess({
      runtime: this.runtime,
      artifact: this.artifact,
      nodeDirectory: this.nodeDirectory,
      profile: path.join(this.root, "profile"),
      database: this.database,
      databaseUrl: this.databaseUrl,
      logs: path.join(this.root, label),
      port,
    });
    this.client = productionClient(this.server);
    await this.client.visit("session", "GET", "/api/auth/session");
    this.bootstrap = await this.client.visit(
      "bootstrap",
      "GET",
      "/api/bootstrap",
    );
  }

  async relay(label) {
    const session = await this.client.visit(
      "open WorkerLink",
      "POST",
      "/api/workers/alpha/worker-link/sessions",
      { status: 201, json: { clientInstanceId: label } },
    );
    const probe = new WorkerLinkProbe(this, session, label);
    this.relays.push(probe);
    await probe.connect();
    return probe;
  }

  async crashAndRestart() {
    const identity = this.bootstrap.server.id;
    const port = this.server.port;
    const connections = this.connections;
    const startedAt = performance.now();
    const crash = await this.server.stop("SIGKILL");
    this.server = undefined;
    await this.startServer("restarted", port);
    assert.equal(this.bootstrap.server.id, identity);
    await eventually(
      () => this.connections,
      (count) => assert.ok(count > connections),
      60000,
    );
    return {
      crash,
      completeMs: performance.now() - startedAt,
      connections: this.connections,
      serverGenerations: this.serverGenerations,
    };
  }

  async observation(probe, initialCreditBytes = 8 * 1024 * 1024) {
    const grant = await this.client.visit(
      "observation grant",
      "POST",
      `/api/worker-links/${probe.session.sessionId}/observations/grant`,
      { status: 201, json: { topics: ["runtime"] } },
    );
    return probe.channel(grant, initialCreditBytes);
  }

  async tunnel(probe, initialCreditBytes = 8 * 1024 * 1024) {
    const id = randomUUID();
    const protectedRecord = { ...tunnelRecord, operationId: id };
    const tunnel = await this.client.visit(
      "create tunnel",
      "POST",
      "/api/tunnels",
      {
        status: 201,
        json: {
          id,
          projectId: null,
          protocolHint: "tcp",
          destination: { kind: "worker-tcp", workerId: "alpha" },
          protectedRecord,
        },
      },
    );
    assert.deepEqual(tunnel.protectedRecord, protectedRecord);
    const attachment = await this.client.visit(
      "tunnel attachment",
      "POST",
      `/api/tunnels/${id}/attachments`,
      {
        status: 201,
        json: { clientId: probe.clientInstanceId },
      },
    );
    const opened = await this.client.visit(
      "tunnel grant",
      "POST",
      `/api/worker-links/${probe.session.sessionId}/tunnel-attachments/${attachment.attachmentId}/grant`,
      { status: 201, json: {} },
    );
    assert.deepEqual(opened.grant.binding.lanes, ["stream"]);
    assert.deepEqual(opened.route.target.protectedRecord, protectedRecord);
    const channel = await probe.channel(opened.grant, initialCreditBytes, {
      lane: "stream",
      kind: "reliable-stream",
    });
    channel.tunnel = {
      id,
      attachmentId: attachment.attachmentId,
      protectedRecord,
    };
    return channel;
  }

  async stopWorker() {
    this.worker?.close();
    await this.gateway?.close();
  }

  async stop() {
    for (const probe of this.relays) {
      probe.socket?.resume();
      probe.socket?.terminate();
    }
    await this.stopWorker();
    try {
      if (this.server) this.exit = await this.server.stop();
    } finally {
      await this.pg?.close();
    }
  }
}

export class WorkerLinkProbe {
  constructor(fixture, session, clientInstanceId) {
    Object.assign(this, { fixture, session, clientInstanceId });
    this.channels = new Map();
    this.frames = [];
    this.receivedBytes = 0;
    this.receivedFrames = 0;
    this.observers = new Set();
  }

  async connect() {
    const cookies = [...this.fixture.client.client().cookies]
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
    const url =
      this.fixture.server.origin.replace(/^http/, "ws") +
      `/api/worker-links/${this.session.sessionId}/connect` +
      `?clientInstanceId=${this.clientInstanceId}&routeGeneration=${this.session.routeGeneration}`;
    this.socket = new WebSocket(url, { headers: { cookie: cookies, origin } });
    this.closed = new Promise((resolve) => {
      this.socket.once("close", (code, reason) => {
        this.closeResult = { code, reason: reason.toString() };
        this.wake?.();
        resolve(this.closeResult);
      });
    });
    this.socket.on("error", (error) => {
      this.failure = error;
      this.wake?.();
    });
    this.socket.on("message", (bytes, binary) => {
      try {
        assert.equal(binary, true);
        const frame = decodeWorkerLinkFrame(bytes);
        const expected = this.fixture.endpointFrames.get(
          frameKey(frame.header),
        );
        assert.equal(digest(bytes), expected, "Exact endpoint frame bytes");
        this.fixture.endpointFrames.delete(frameKey(frame.header));
        const channel = this.channels.get(frame.header.channel.channelId);
        assert.ok(channel, "Frame belongs to an opened channel");
        for (const key of Object.keys(channel.identity))
          assert.deepEqual(frame.header[key], channel.identity[key], key);
        assert.equal(frame.header.sequence, ++channel.workerSequence);
        this.receivedBytes += bytes.byteLength;
        this.receivedFrames++;
        this.frames.push({
          header: frame.header,
          payloadBytes: frame.payload.byteLength,
        });
        for (const observer of this.observers) observer(frame, bytes);
      } catch (error) {
        this.failure = error;
        this.wake?.();
      }
    });
    let timer;
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          this.socket.terminate();
          reject(new Error("WorkerLink handshake timed out"));
        }, 10000);
        this.socket.once("open", resolve);
        this.socket.once("error", reject);
        this.socket.once("unexpected-response", (_request, response) => {
          response.resume();
          reject(new Error("WorkerLink handshake HTTP " + response.statusCode));
        });
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async channel(
    grant,
    initialCreditBytes,
    {
      lane = "events",
      kind = "event-subscription",
      expectedKind = "accept",
    } = {},
  ) {
    const identity = {
      protocolVersion: 1,
      sessionId: this.session.sessionId,
      routeGeneration: this.session.routeGeneration,
      effectiveRoute: "relay",
      channel: { channelId: randomUUID(), connectionId: randomUUID() },
      lane,
    };
    const channel = { identity, grant, workerSequence: -1, clientSequence: 0 };
    this.channels.set(identity.channel.channelId, channel);
    this.socket.send(
      encodeWorkerLinkFrame(
        {
          ...identity,
          kind: "open",
          sequence: 0,
          openNonce: randomUUID(),
          channelKind: kind,
          grant,
          initialCreditBytes,
        },
        new Uint8Array(),
      ),
    );
    await eventually(
      () =>
        this.frames.find(
          (frame) =>
            frame.header.channel.channelId === identity.channel.channelId,
        ),
      (frame) => {
        if (this.failure) throw this.failure;
        assert.equal(frame?.header.kind, expectedKind);
      },
    );
    channel.endpoint = this.fixture.channels.get(identity.channel.channelId);
    if (expectedKind === "accept") assert.ok(channel.endpoint);
    channel.openedAt = performance.now();
    return channel;
  }

  credit(channel, bytes) {
    this.socket.send(
      encodeWorkerLinkFrame(
        {
          ...channel.identity,
          kind: "credit",
          sequence: ++channel.clientSequence,
          direction: "worker-to-client",
          bytes,
        },
        new Uint8Array(),
      ),
    );
  }

  data(channel, payload) {
    this.socket.send(
      encodeWorkerLinkFrame(
        {
          ...channel.identity,
          kind: "data",
          sequence: ++channel.clientSequence,
          direction: "client-to-worker",
          payloadFormat: "raw",
        },
        payload,
      ),
    );
  }

  async close() {
    this.socket.resume();
    this.socket.close(1000);
    return this.closed;
  }
}
