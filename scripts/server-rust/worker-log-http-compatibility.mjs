// Run isolated Source/native worker-log behavior on real HTTP and WebSockets.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdtemp,
  mkdir,
  copyFile,
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
import { password, heartbeat } from "./security-fixtures.mjs";
import {
  literal,
  json,
  localOwner,
  otherOwner,
  stamp,
} from "./project-target-state.mjs";
import { readResult, workerLogHttpCases } from "./worker-log-http-cases.mjs";
import { workerLogStreamCases } from "./worker-log-stream-cases.mjs";
import { workerLogTimerCases } from "./worker-log-timer-cases.mjs";
import {
  workerLogStressCases,
  workerLogAccounting,
  workerLogStartupPressure,
} from "./worker-log-stress-cases.mjs";
import { workerLogQueryLifetime } from "./worker-log-query-lifetime.mjs";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    profile: { type: "string" },
    runtime: { type: "string" },
    report: { type: "string" },
    timers: { type: "boolean", default: false },
    stress: { type: "boolean", default: false },
    accounting: { type: "boolean", default: false },
    "query-lifetime": { type: "boolean", default: false },
    "startup-pressure": { type: "boolean", default: false },
  },
});
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(values.database));
assert.ok(
  !values.profile || ["none", "password", "accounts"].includes(values.profile),
);
assert.ok(!values.runtime || ["node", "rust"].includes(values.runtime));
const root = await mkdtemp(path.join(tmpdir(), "cantrip-worker-log-http-"));
console.error(JSON.stringify({ event: "worker-log.created", root }));
const report = {
  root,
  database: values.database,
  profiles: [],
  completeReplacement: false,
  scope:
    "Actual HTTP/SQL/WebSocket and unchanged WorkerConnection; endpoint log production is controlled. Full worker/product/platform acceptance remains separate.",
};
let pg, failure;
async function run(f, result, profile) {
  const state = { commands: [], background: [], disconnects: 0 };
  const visit = async (name, method, url, options = {}) => {
    result.http.push({
      name,
      ...(await f.observe(name, method, url, { csrf: true, ...options })),
    });
    return f.records.get(name);
  };
  let worker, server;
  const streams = [];
  try {
    await f.start();
    server = f.server;
    const logRoot = path.join(root, profile, f.kind, "process-logs");
    await mkdir(logRoot, { recursive: true });
    for (const [name, input] of [
      ["stdout", server.child.stdout],
      ["stderr", server.child.stderr],
    ]) {
      const stream = createWriteStream(path.join(logRoot, name + ".log"));
      input.pipe(stream);
      streams.push(stream);
    }
    result.startup = {
      origin: server.origin,
      events: server.events.slice(),
      diagnostics: server.diagnostics(),
    };
    const auth =
      profile === "accounts"
        ? await visit("register", "POST", "/api/auth/register", {
            status: 201,
            json: {
              email: "logs@example.invalid",
              displayName: "Log owner",
              password,
            },
          })
        : profile === "password"
          ? await visit("login", "POST", "/api/auth/login", {
              json: { password },
            })
          : await visit("session", "GET", "/api/auth/session");
    const owner = auth.currentUser?.id ?? localOwner;
    const handlers = {
      "diagnostics.logs.read": async (command) => {
        state.commands.push(command);
        if (state.readHold) await state.readHold;
        if (state.error) throw new Error(state.error);
        return Object.hasOwn(state, "reply") ? state.reply : readResult();
      },
      "diagnostics.logs.stream.start": async (command) => {
        state.commands.push(command);
        if (state.beforeStartAck) await state.beforeStartAck(command);
        if (state.startHold) await state.startHold;
        if (state.startError) throw new Error(state.startError);
        return state.startReply ?? { accepted: true, latestCursor: 9 };
      },
      "diagnostics.logs.stream.renew": async (command) => {
        state.commands.push(command);
        const override = state.renewOverrides?.get(command.subscriptionId);
        if (override?.error) throw new Error(override.error);
        if (override) return override.reply;
        if (state.renewError) throw new Error(state.renewError);
        return state.renewReply ?? { accepted: true };
      },
      "diagnostics.logs.stream.stop": async (command) => {
        state.commands.push(command);
        return { accepted: true };
      },
    };
    worker = await managementWorker({
      f,
      visit,
      root: path.join(root, profile, f.kind),
      state,
      handlers,
    });
    await f.sql([
      `INSERT INTO users(id,kind,display_name,role,status,email,normalized_email) VALUES(${literal(otherOwner)},'account','Other log owner','member','active','other-logs@example.invalid','other-logs@example.invalid')`,
      ...[
        ["beta", owner],
        ["foreign", otherOwner],
      ].map(
        ([id, user]) =>
          `INSERT INTO workers(id,owner_id,name,platform,architecture,remote_surface_capabilities,started_at,last_seen_at,created_at,updated_at) VALUES(${literal(id)},${literal(user)},'Log fixture','linux','x64',${json(heartbeat.remoteSurfaces)},${literal(stamp)},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
      ),
    ]);
    await workerLogHttpCases({ f, state, visit, result, profile });
    await workerLogStreamCases({ f, state, worker, visit, result, profile });
    if (values.timers && profile === "none")
      await workerLogTimerCases({ f, state, result });
    if (values.stress && profile === "none")
      await workerLogStressCases({ f, state, worker, result, root: logRoot });
    if (values["startup-pressure"] && profile === "none")
      await workerLogStartupPressure({
        f,
        state,
        worker,
        result,
        root: logRoot,
      });
    if (values.accounting && profile === "none")
      await workerLogAccounting({ f, state, owner, result });
    if (values["query-lifetime"] && profile === "none")
      await workerLogQueryLifetime({ f, state, visit, result });
    result.commands = state.commands;
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
          event: "worker-log.started",
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
        profile + " stream and command behavior",
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
