// Compare current Source and native routes through real HTTP, SQL and workers.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { HttpFixture } from "./http-fixture.mjs";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { managementWorker } from "./worker-management-http-worker.mjs";
import { password } from "./security-fixtures.mjs";
import { localOwner, targetStateSql } from "./project-target-state.mjs";
import {
  inventory,
  desktopGeneration,
} from "./remote-surface-contract-oracle.mjs";
import { json as sqlJson } from "./project-target-state.mjs";
import { encodeRemoteSurfaceFrame } from "../../packages/protocol/dist/index.js";
import { remoteSurfaceAccounting } from "./remote-surface-stress-cases.mjs";
import { remoteSurfaceHttpCases } from "./remote-surface-http-cases.mjs";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    profile: { type: "string" },
    runtime: { type: "string" },
    report: { type: "string" },
    timers: { type: "boolean", default: false },
    quota: { type: "string" },
    stress: { type: "boolean", default: false },
    accounting: { type: "boolean", default: false },
  },
});
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(values.database));
assert.ok(
  !values.profile || ["none", "password", "accounts"].includes(values.profile),
);
assert.ok(!values.quota || ["worker", "account"].includes(values.quota));
assert.ok(!values.runtime || ["node", "rust"].includes(values.runtime));
const root = await mkdtemp(path.join(tmpdir(), "cantrip-remote-surface-http-"));
console.error(JSON.stringify({ event: "remote-surface.created", root }));
const report = {
  root,
  database: values.database,
  profiles: [],
  completeReplacement: false,
  scope:
    "Actual HTTP/SQL and unchanged WorkerConnection. Controlled command producers; full browser/worker and platform acceptance remain separate.",
};
let pg, failure;
async function run(f, result, profile) {
  const state = {
    commands: [],
    background: [],
    frames: [],
    workerFrames: [],
    disconnects: 0,
    quotaKind: values.quota,
  };
  const visit = async (name, method, url, options = {}) => {
    // Compare responses by request, including independently completing timers.
    const index = result.http.length;
    result.http.push({ name, pending: true });
    const started = performance.now();
    result.http[index] = {
      name,
      ...(await f.observe(name, method, url, { csrf: true, ...options })),
    };
    (result.rawHttp ??= []).push({
      index,
      name,
      elapsedMs: performance.now() - started,
      body: f.records.get(name),
    });
    return f.records.get(name);
  };
  let worker, server;
  const streams = [];
  try {
    await f.start();
    server = f.server;
    const logs = path.join(root, profile, f.kind, "process-logs");
    await mkdir(logs, { recursive: true });
    for (const [name, input] of [
      ["stdout", server.child.stdout],
      ["stderr", server.child.stderr],
    ]) {
      const stream = createWriteStream(path.join(logs, name + ".log"));
      input.pipe(stream);
      streams.push(stream);
    }
    result.startup = { origin: server.origin, events: server.events.slice() };
    const auth =
      profile === "accounts"
        ? await visit("register", "POST", "/api/auth/register", {
            status: 201,
            json: {
              email: "insights@example.invalid",
              displayName: "Insights owner",
              password,
            },
          })
        : profile === "password"
          ? await visit("login", "POST", "/api/auth/login", {
              json: { password },
            })
          : await visit("session", "GET", "/api/auth/session");
    const owner = auth.currentUser?.id ?? localOwner;
    const handlers = Object.fromEntries(
      [
        "surface.desktop.probe",
        "surface.desktop.targets",
        "surface.configure",
        "surface.close",
        "surface.suspend",
        "surface.resume",
        "surface.attach",
        "surface.detach",
        "surface.desktop.os-prepare",
      ].map((type) => [
        type,
        async (command) => {
          state.commands.push(command);
          if (state.intercept) await state.intercept(command);
          if (state.hold) await state.hold;
          if (state.holds?.[type]) await state.holds[type];
          if (state.errors?.[type]) throw new Error(state.errors[type]);
          if (Object.hasOwn(state.replies ?? {}, type))
            return state.replies[type];
          if (type === "surface.desktop.probe")
            return { available: true, message: null };
          if (type === "surface.desktop.targets")
            return { ...inventory, operationId: command.operationId };
          if (type === "surface.attach")
            return { accepted: true, transport: "websocket" };
          if (type === "surface.desktop.os-prepare")
            return { desktopGeneration };
          return { accepted: true };
        },
      ]),
    );
    worker = await managementWorker({
      f,
      visit,
      root: path.join(root, profile, f.kind),
      state,
      handlers,
      onSentSurfaceFrame: (header, payload) =>
        state.workerFrames.push({
          header: structuredClone(header),
          bytes: encodeRemoteSurfaceFrame(header, payload).byteLength,
        }),
      onSurfaceFrame: (header, payload) => {
        state.frames.push({
          header,
          payload: Buffer.from(payload).toString("hex"),
          bytes: encodeRemoteSurfaceFrame(header, payload).byteLength,
        });
      },
    });
    await f.sql(
      targetStateSql(owner).filter(
        (sql) =>
          !sql.startsWith("INSERT INTO workers(id") ||
          !sql.includes("VALUES('alpha',"),
      ),
    );
    await f.sql([
      `UPDATE workers SET remote_surface_capabilities=${sqlJson({ browser: true, desktop: true, transports: ["websocket", "webrtc"], iceTransportPolicies: ["all", "relay"], maxSessions: 8 })} WHERE id='alpha'`,
    ]);
    await remoteSurfaceHttpCases({
      f,
      state,
      worker,
      visit,
      result,
      profile,
      owner,
      timers: values.timers,
      stress: values.stress,
    });
    if (values.accounting)
      await remoteSurfaceAccounting({ f, state, owner, result });
    result.cases = f.normalize(result.cases);
    result.passed = true;
  } finally {
    result.diagnostics = server?.diagnostics();
    worker?.close();
    try {
      await f.close();
    } finally {
      if (server)
        result.exit = {
          code: server.child.exitCode,
          signal: server.child.signalCode,
        };
      for (const stream of streams)
        if (!stream.writableFinished)
          await new Promise((resolve) => stream.once("finish", resolve));
    }
  }
}
try {
  let executable;
  if (values.runtime !== "node") {
    const built =
      process.env.CANTRIP_RUST_SERVER_BINARY ??
      (await buildRustExample("http-sql-fixture"));
    await mkdir(path.join(root, "bin"));
    executable = path.join(root, "bin", path.basename(built));
    await copyFile(built, executable);
    report.nativeExecutable = {
      path: executable,
      sha256: createHash("sha256")
        .update(await readFile(executable))
        .digest("hex"),
    };
  }
  const passwordHash = await hashPassword(password);
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of values.profile
    ? [values.profile]
    : ["none", "password", "accounts"]) {
    const peers = [];
    report.profiles.push({ profile, runtimes: peers });
    for (const kind of values.runtime ? [values.runtime] : ["node", "rust"]) {
      console.error(
        JSON.stringify({
          event: "remote-surface.started",
          profile,
          kind,
          database: values.database,
        }),
      );
      const result = { kind, http: [], cases: [] };
      peers.push(result);
      const url =
        pg && (kind === "node" || values.database === "postgres")
          ? await pg.database()
          : undefined;
      const f = new HttpFixture({
        kind,
        executable,
        root,
        name: profile,
        databaseMode: values.database,
        liveSqlFixture: true,
        environment: {
          CANTRIP_AUTH_MODE: profile,
          CANTRIP_REGISTRATION_ENABLED: "true",
          CANTRIP_FIXTURE_LOGGING: "true",
          ...(values.stress
            ? {
                CANTRIP_ACCOUNT_RELAY_BYTES_PER_MINUTE: "1073741824",
                CANTRIP_WORKER_RELAY_BYTES_PER_MINUTE: "1073741824",
              }
            : {}),
          ...(values.quota
            ? {
                CANTRIP_ACCOUNT_REMOTE_SURFACE_LIMIT:
                  values.quota === "account" ? "2" : "10",
                CANTRIP_WORKER_REMOTE_SURFACE_LIMIT:
                  values.quota === "worker" ? "2" : "10",
              }
            : {}),
          ...(profile === "password"
            ? { CANTRIP_PASSWORD_HASH: passwordHash }
            : {}),
          ...(url ? { DATABASE_URL: url } : {}),
          ...(kind === "rust" && values.database === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      });
      await run(f, result, profile);
    }
    if (peers.length === 2) {
      assert.deepEqual(
        peers[1].http,
        peers[0].http,
        profile + " complete HTTP contracts",
      );
      assert.deepEqual(
        peers[1].cases,
        peers[0].cases,
        profile + " command/state behavior",
      );
    }
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  try {
    await pg?.close();
  } catch (error) {
    failure ??= error;
    report.teardownFailure = error.stack;
  }
  if (values.report) {
    await mkdir(path.dirname(path.resolve(values.report)), { recursive: true });
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  }
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    root,
    passed: report.passed,
    profiles: report.profiles.map((p) => ({
      profile: p.profile,
      runtimes: p.runtimes.map((r) => ({
        kind: r.kind,
        http: r.http.length,
        cases: r.cases.length,
        exit: r.exit,
      })),
    })),
  }),
);
