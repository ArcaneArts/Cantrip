// Controlled discovery replies travel through the unchanged worker transport.
import assert from "node:assert/strict";
import path from "node:path";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { sendHeartbeat } from "../../cantrip_worker/src/heartbeat.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { heartbeat } from "./security-fixtures.mjs";
import { literal, json, label } from "./project-target-state.mjs";
import { eventually } from "./full-worker.mjs";

export const connectedIds = [
  "alpha",
  "beta",
  ...Array.from({ length: 8 }, (_, i) => `service-${i}`),
];
export function service(index = 0) {
  return {
    workerId: "untrusted-worker-claim",
    host: " 127.0.0.1 ",
    port: 4100 + index,
    protocol: "http",
    url: `http://127.0.0.1:${4100 + index}/`,
    title: " Development ",
    processName: null,
    statusCode: 200,
    ignored: "strip this unknown field",
  };
}
export function discoveryStateSql(owner) {
  const sql = [];
  for (const [id, name, browser] of [
    ...connectedIds.slice(2).map((id) => [id, id, true]),
    ...Array.from({ length: 65 }, (_, i) => [
      `zz-${String(i).padStart(2, "0")}`,
      `zz worker ${String(i).padStart(2, "0")}`,
      true,
    ]),
    ["not-browser", "Never scan", false],
    ["unlinked-browser", "Never scan unlinked", true],
  ])
    sql.push(
      `INSERT INTO workers(id,owner_id,name,platform,architecture,remote_surface_capabilities,started_at,last_seen_at) VALUES(${literal(id)},${literal(owner)},${literal(name)},'linux','x64',${json({ browser, desktop: false })},'2026-10-25','2099-01-01')`,
    );
  sql.push(
    "UPDATE workers SET unlinked_at='2026-10-25' WHERE id='unlinked-browser'",
    "UPDATE workers SET display_name='á' WHERE id='alpha'",
    "UPDATE workers SET display_name='a' WHERE id='beta'",
    `UPDATE workers SET display_name=${literal("Boundary " + "x".repeat(190) + "🧪tail")} WHERE id='�'`,
    `INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,git_capability,github_capability,worktree_policy,preferred_worker_id) VALUES('empty-folder',${literal(owner)},${json(label("project"))},'managed-folder','external',false,false,'direct','not-browser')`,
  );
  return sql;
}
export class DiscoveryWorkers {
  constructor({ fixture, root, visit, result }) {
    Object.assign(this, { fixture, root, visit, result });
    this.connections = new Map();
    this.configs = new Map();
    this.modes = new Map();
    this.pending = [];
  }
  async enroll(id) {
    await this.visit(
      "enrollment code " + id,
      "POST",
      "/api/workers/enrollment-codes",
      { json: {}, status: 201 },
    );
    const response = await this.visit(
      "enroll " + id,
      "POST",
      "/api/internal/workers/enroll",
      {
        client: "worker",
        status: 201,
        json: {
          code: this.fixture.records.get("enrollment code " + id).code,
          heartbeat: {
            ...heartbeat,
            workerId: id,
            remoteSurfaces: {
              browser: true,
              desktop: true,
              transports: ["websocket", "webrtc"],
              maxSessions: 8,
            },
          },
        },
      },
    );
    const config = {
      dataDirectory: path.join(this.root, id),
      name: "Discovery worker",
      serverUrl: this.fixture.server.origin,
      enrollmentCode: null,
      replacement: null,
      token: response.credential,
      tokenSource: "persisted",
      workerId: id,
    };
    saveWorkerCredential({
      credential: config.token,
      dataDirectory: config.dataDirectory,
      serverUrl: config.serverUrl,
      workerId: id,
    });
    this.configs.set(id, config);
    await this.connect(id);
  }
  async connect(id) {
    let ready = false;
    const connection = new WorkerConnection(
      this.configs.get(id),
      async (command) => {
        if (command.type !== "browser.services.discover") return null;
        this.result.commands.push({ workerId: id, command });
        const mode = this.modes.get(id) ?? "valid";
        if (mode === "error") throw new Error("Controlled discovery failure");
        if (mode === "blank-error") throw new Error(" ");
        if (mode === "timeout-message")
          throw new Error("Discovery TiMeD OuT while probing");
        if (mode === "long-error") throw new Error("x".repeat(999) + "🧪tail");
        if (mode === "hold")
          return await new Promise((resolve) => this.pending.push(resolve));
        if (mode === "undefined") return undefined;
        if (mode === "bulk")
          return Array.from({ length: 128 }, (_, i) => service(i));
        if (mode === "over-limit")
          return Array.from({ length: 129 }, (_, i) => service(i));
        if (mode === "bad-claim") return [{ ...service(), workerId: "" }];
        if (mode === "bad-url")
          return [{ ...service(), url: "HTTP://127.0.0.1:4100/" }];
        if (mode === "trimmed-url")
          return [{ ...service(), url: " http://127.0.0.1:4100/ " }];
        return [service()];
      },
      undefined,
      undefined,
      undefined,
      1000,
      () => (ready = true),
    );
    this.connections.set(id, connection);
    connection.start();
    await eventually(
      () => ready,
      (value) => assert.equal(value, true),
    );
  }
  async refresh() {
    await Promise.all(
      [...this.connections.keys()].map((id) =>
        sendHeartbeat(this.configs.get(id), {
          ...heartbeat,
          workerId: id,
          remoteSurfaces: {
            browser: true,
            desktop: true,
            transports: ["websocket", "webrtc"],
            maxSessions: 8,
          },
        }),
      ),
    );
  }
  release() {
    for (const resolve of this.pending.splice(0)) resolve([service()]);
  }
  disconnect(id) {
    this.connections.get(id)?.close();
    this.connections.delete(id);
  }
  close() {
    this.release();
    for (const id of this.connections.keys()) this.disconnect(id);
  }
}
