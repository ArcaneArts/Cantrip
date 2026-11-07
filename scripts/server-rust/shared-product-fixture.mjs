// Existing product scenarios, two actual production server graphs and one full
// worker attached to the peer opposite the application. No command substitutes.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { HttpFixture } from "./http-fixture.mjs";
import { redisFixture } from "./coordinated-fixture-tools.mjs";
import { eventually } from "./full-worker.mjs";
import { startPackagedNodeServer } from "./packaged-node-fixture.mjs";
import { repositoryRoot } from "./build.mjs";

export class SharedProductFixture {
  static async create({ clientKind, workerKind, databaseUrl, ...options }) {
    const directory = path.join(options.root, options.name);
    await mkdir(directory, { recursive: true });
    const redis = await redisFixture(
      process.env.CANTRIP_TEST_REDIS_BIN ?? "redis-server",
      directory,
    );
    return new SharedProductFixture({
      ...options,
      clientKind,
      workerKind,
      databaseUrl,
      directory,
      redis,
    });
  }
  constructor({
    clientKind,
    workerKind,
    databaseUrl,
    directory,
    redis,
    ...options
  }) {
    this.kind = `${clientKind}-${workerKind}`;
    this.databaseMode = "postgres";
    this.directory = directory;
    this.redis = redis;
    this.generations = [];
    this.peers = [clientKind, workerKind].map(
      (kind, index) =>
        new HttpFixture({
          ...options,
          kind,
          name: options.name + "-" + index,
          databaseMode: "postgres",
          environment: {
            ...options.environment,
            DATABASE_URL: databaseUrl,
            REDIS_URL: redis.url,
            CANTRIP_COORDINATION_MAX_INSTANCES: "2",
            CANTRIP_COORDINATION_PRESENCE_TTL_MS: "5000",
            CANTRIP_SERVER_INSTANCE_ID: randomUUID(),
          },
        }),
    );
    this.ports = [0, 0];
  }
  get server() {
    return this.peers[0].server;
  }
  get environment() {
    return this.peers[0].environment;
  }
  get workerFixture() {
    return this.peers[1];
  }
  get records() {
    return this.peers[0].records;
  }
  client(...args) {
    return this.peers[0].client(...args);
  }
  observe(...args) {
    return this.peers[0].observe(...args);
  }
  sql(...args) {
    return this.peers[0].sql(...args);
  }
  async startPeer(index) {
    const peer = this.peers[index];
    if (peer.kind === "node") {
      peer.server = await startPackagedNodeServer(
        path.join(repositoryRoot, "cantrip_server"),
        peer.environment,
        { nodeExecutable: process.execPath, port: this.ports[index] },
      );
    } else await peer.start({ port: this.ports[index] });
    this.ports[index] = Number(new URL(peer.server.origin).port);
    const generation = {
      peer: index,
      kind: peer.kind,
      port: this.ports[index],
      pid: peer.server.child.pid,
      instanceId: peer.environment.CANTRIP_SERVER_INSTANCE_ID,
    };
    this.generations.push(generation);
    for (const stream of ["stdout", "stderr"]) {
      const file = path.join(
        this.directory,
        `peer-${index}-${this.generations.length}.${stream}.log`,
      );
      appendFileSync(file, "");
      peer.server.child[stream].on("data", (chunk) =>
        appendFileSync(file, chunk),
      );
    }
    await eventually(
      async () => {
        const response = await fetch(peer.server.origin + "/readyz", {
          signal: AbortSignal.timeout(5000),
        });
        return { status: response.status, body: await response.json() };
      },
      (value) => {
        assert.equal(value.status, 200, JSON.stringify(value));
        assert.deepEqual(value.body.coordination, {
          shared: true,
          status: "ready",
        });
        assert.equal(value.body.database.engine, "postgres");
      },
    );
  }
  async start() {
    try {
      await this.startPeer(0);
      await this.startPeer(1);
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }
  async close(options) {
    const results = await Promise.allSettled(
      this.peers.map(async (peer, index) => {
        const server = peer.server;
        try {
          await peer.close(options);
        } finally {
          if (server) {
            const generation = this.generations.findLast(
              (g) => g.pid === server.child.pid && g.peer === index,
            );
            if (generation)
              Object.assign(generation, {
                exitCode: server.child.exitCode,
                signal: server.child.signalCode,
                shutdownStages: server.events.filter(
                  (e) => e.event === "server.shutdown.stage",
                ),
                diagnostics: server.diagnostics(),
              });
          }
        }
      }),
    );
    for (const result of results)
      if (result.status === "rejected") throw result.reason;
  }
  async dispose() {
    try {
      await this.close();
    } finally {
      await this.redis.stop();
    }
  }
  async replacePeer(index, kind = "rust", { crash = false } = {}) {
    const peer = this.peers[index];
    const server = peer.server;
    const before = {
      kind: peer.kind,
      instanceId: peer.environment.CANTRIP_SERVER_INSTANCE_ID,
      pid: server.child.pid,
    };
    if (crash) {
      assert.equal(server.child.exitCode, null);
      assert.equal(server.child.signalCode, null);
      const completion = once(server.child, "close");
      assert.equal(server.child.kill("SIGKILL"), true);
      const [code, signal] = await completion;
      assert.equal(code, null);
      assert.equal(signal, "SIGKILL");
      peer.server = undefined;
    } else await peer.close();
    const generation = this.generations.findLast(
      (g) => g.pid === server.child.pid && g.peer === index,
    );
    Object.assign(generation, {
      exitCode: server.child.exitCode,
      signal: server.child.signalCode,
      diagnostics: server.diagnostics(),
      ...(crash ? { intentionalInterruption: "SIGKILL" } : {}),
    });
    peer.kind = kind;
    peer.environment.CANTRIP_SERVER_INSTANCE_ID = randomUUID();
    await this.startPeer(index);
    return {
      peer: index,
      before,
      after: {
        kind,
        instanceId: peer.environment.CANTRIP_SERVER_INSTANCE_ID,
        pid: peer.server.child.pid,
      },
    };
  }
  async workerClaim(workerId) {
    return JSON.parse(
      await this.redis.client.get(
        "cantrip:relay:v1:worker:" + encodeURIComponent(workerId),
      ),
    );
  }
  async assertRemoteWorker(workerId) {
    const claim = await this.workerClaim(workerId);
    assert.equal(
      claim?.instanceId,
      this.workerFixture.environment.CANTRIP_SERVER_INSTANCE_ID,
      "full worker must actually belong to the other server process",
    );
    assert.notEqual(
      claim.instanceId,
      this.environment.CANTRIP_SERVER_INSTANCE_ID,
    );
    assert.ok(claim.connectionId);
    return claim;
  }
}
