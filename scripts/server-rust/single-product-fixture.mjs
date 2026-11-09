// One actual production server and its retained private profile. No SQL routes
// or injected worker bridge are installed in either runtime.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { HttpFixture } from "./http-fixture.mjs";
import { startPackagedNodeServer } from "./packaged-node-fixture.mjs";
import { repositoryRoot } from "./build.mjs";

export class SingleProductFixture extends HttpFixture {
  constructor(options) {
    super(options);
    this.directory = path.join(
      options.root,
      options.name,
      this.kind,
      "generations",
    );
    this.generations = [];
    this.environment.CANTRIP_SERVER_INSTANCE_ID = randomUUID();
  }
  async start({ port = 0 } = {}) {
    assert.equal(this.server, undefined);
    await mkdir(this.directory, { recursive: true });
    if (this.kind === "node") {
      this.server = await startPackagedNodeServer(
        path.join(repositoryRoot, "tests/reference-node-server"),
        this.environment,
        { nodeExecutable: process.execPath, port },
      );
    } else await super.start({ port });
    const server = this.server;
    const response = await fetch(server.origin + "/readyz");
    assert.equal(response.status, 200);
    const ready = await response.json();
    this.generations.push({
      pid: server.child.pid,
      kind: this.kind,
      instanceId: this.environment.CANTRIP_SERVER_INSTANCE_ID,
      origin: server.origin,
      database: ready.database,
    });
    for (const stream of ["stdout", "stderr"]) {
      const file = path.join(
        this.directory,
        `${this.generations.length}.${stream}.log`,
      );
      appendFileSync(file, "");
      server.child[stream].on("data", (chunk) => appendFileSync(file, chunk));
    }
  }
  recordExit(server, extra = {}) {
    Object.assign(
      this.generations.findLast((g) => g.pid === server.child.pid),
      {
        exitCode: server.child.exitCode,
        signal: server.child.signalCode,
        diagnostics: server.diagnostics(),
        ...extra,
      },
    );
  }
  async close(options) {
    const server = this.server;
    try {
      await super.close(options);
    } finally {
      if (server) this.recordExit(server);
    }
  }
  async restart({ crash = false } = {}) {
    const server = this.server;
    const before = {
      pid: server.child.pid,
      origin: server.origin,
      instanceId: this.environment.CANTRIP_SERVER_INSTANCE_ID,
    };
    if (crash) {
      const completion = once(server.child, "close");
      assert.equal(server.child.kill("SIGKILL"), true);
      const [code, signal] = await completion;
      assert.equal(code, null);
      assert.equal(signal, "SIGKILL");
      this.server = undefined;
      this.recordExit(server, { intentionalInterruption: "SIGKILL" });
    } else await this.close();
    this.environment.CANTRIP_SERVER_INSTANCE_ID = randomUUID();
    await this.start({ port: Number(new URL(before.origin).port) });
    assert.equal(this.server.origin, before.origin);
    return {
      before,
      after: {
        pid: this.server.child.pid,
        origin: this.server.origin,
        instanceId: this.environment.CANTRIP_SERVER_INSTANCE_ID,
      },
    };
  }
}
