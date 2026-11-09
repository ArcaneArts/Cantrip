// Real production routers, SQL, and unchanged WorkerConnection; replies controlled.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
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
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { HttpFixture } from "./http-fixture.mjs";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { managementWorker } from "./worker-management-http-worker.mjs";
import { password } from "./security-fixtures.mjs";
import {
  localOwner,
  literal,
  targetStateSql,
} from "./project-target-state.mjs";
import { computerUseHttpCases } from "./computer-use-http-cases.mjs";
import { opaque } from "./computer-use-http-fixtures.mjs";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    profile: { type: "string" },
    runtime: { type: "string" },
    report: { type: "string" },
    timers: { type: "boolean", default: false },
    "sql-timeout": { type: "boolean", default: false },
    limits: { type: "boolean", default: false },
    production: { type: "boolean", default: false },
  },
});
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(values.database));
assert.ok(
  !values.profile || ["none", "password", "accounts"].includes(values.profile),
);
assert.ok(!values.runtime || ["node", "rust"].includes(values.runtime));
const root = await mkdtemp(path.join(tmpdir(), "cantrip-computer-use-http-"));
console.error(JSON.stringify({ event: "computer-use.created", root }));
const report = {
  root,
  database: values.database,
  production: values.production,
  profiles: [],
  completeReplacement: false,
  scope:
    "Real HTTP/SQL and unchanged WorkerConnection. Controlled native replies; full worker/native product and platform acceptance remain separate.",
};
let pg, failure;
async function run(f, result, profile) {
  let observer;
  if (values.production) {
    assert.ok(
      f.environment.DATABASE_URL,
      "Production qualification observes its fixture-owned external PostgreSQL database",
    );
    const postgres = createRequire(
      new URL(
        "../../tests/reference-node-server/package.json",
        import.meta.url,
      ),
    )("postgres");
    observer = postgres(f.environment.DATABASE_URL, { max: 1 });
    f.sql = (statements, queries = []) =>
      observer.begin(async (sql) => {
        // Match the SQL fixture's transaction, including deferred constraints.
        for (const statement of statements) await sql.unsafe(statement);
        const values = [];
        for (const query of queries) {
          const rows = await sql.unsafe(query);
          assert.equal(
            rows.length,
            1,
            "SQL observation returns exactly one result row",
          );
          values.push(JSON.parse(rows[0].result));
        }
        return values;
      });
  }
  const state = { commands: [], background: [], disconnects: 0 };
  const visit = async (name, method, url, options = {}) => {
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
    if (values.production) {
      const control = await fetch(server.origin + "/__fixture/sql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statements: [], queries: [] }),
      });
      result.productionSqlControlStatus = control.status;
      assert.equal(control.status, 404, "Production has no SQL control route");
      await control.arrayBuffer();
    }
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
    const auth =
      profile === "accounts"
        ? await visit("register", "POST", "/api/auth/register", {
            status: 201,
            json: {
              email: "computer-use@example.invalid",
              displayName: "CUA owner",
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
        "computer-use.preview.open",
        "computer-use.preview.stop",
        "computer-use.operation",
        "computer-use.approval.respond",
      ].map((type) => [
        type,
        async (command, emit) => {
          state.commands.push(command);
          if (state.intercept) await state.intercept(command, emit);
          if (state.events)
            for (const event of state.events(command)) await emit(event);
          if (state.hold) await state.hold;
          if (state.fail)
            throw new Error("Private native failure must remain opaque");
          if (Object.hasOwn(state, "reply"))
            return typeof state.reply === "function"
              ? state.reply(command)
              : state.reply;
          if (type === "computer-use.preview.open")
            return {
              leaseId: "22222222-2222-4222-8222-222222222222",
              workerId: command.authority.workerId,
              chatId: command.authority.chatId,
              contentDomain: command.contentDomain,
              generation: command.authority.generation,
            };
          if (type === "computer-use.preview.stop") return { closed: true };
          if (type === "computer-use.approval.respond")
            return { accepted: true };
          return {
            operationId: command.request.operationId,
            protectedContent: opaque(),
          };
        },
      ]),
    );
    worker = await managementWorker({
      f,
      visit,
      root: path.join(root, profile, f.kind),
      state,
      handlers,
    });
    await f.sql(
      targetStateSql(owner).filter(
        (sql) =>
          !sql.startsWith("INSERT INTO workers(id") ||
          !sql.includes("VALUES('alpha',"),
      ),
    );
    await f.sql([
      `UPDATE user_settings SET computer_use_enabled=true,auto_name_chats=false,auto_name_tasks=false WHERE user_id=${literal(owner)}`,
      "UPDATE chats SET automation_paused=true",
    ]);
    await computerUseHttpCases({
      f,
      visit,
      worker,
      state,
      result,
      owner,
      profile,
      timers: values.timers,
      sqlTimeout: values["sql-timeout"],
      limits: values.limits,
    });
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
      await observer?.end();
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
    const runtimes = [];
    report.profiles.push({ profile, runtimes });
    for (const kind of values.runtime ? [values.runtime] : ["node", "rust"]) {
      console.error(
        JSON.stringify({
          event: "computer-use.started",
          profile,
          kind,
          database: values.database,
        }),
      );
      const result = { kind, http: [], cases: [] };
      runtimes.push(result);
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
        liveSqlFixture: !values.production,
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
    if (runtimes.length === 2) {
      assert.deepEqual(
        runtimes[1].http,
        runtimes[0].http,
        "complete CUA HTTP contracts",
      );
      assert.deepEqual(
        runtimes[1].cases,
        runtimes[0].cases,
        "CUA commands/state/events",
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
  if (values.report)
    await writeFile(
      path.resolve(values.report),
      JSON.stringify(report, null, 2) + "\n",
    );
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
