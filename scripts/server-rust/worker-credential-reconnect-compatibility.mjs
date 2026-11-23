// Actual worker connections, durable credentials and counter-only server logs.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { managementWorker } from "./worker-management-http-worker.mjs";
import { eventually } from "./full-worker.mjs";
import { localOwner } from "./project-target-state.mjs";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import { capturedCredentialFixture } from "./settings-provider-fixtures.mjs";
import { credentialReconnectShutdown } from "./worker-credential-reconnect-shutdown.mjs";
import {
  privateMarker,
  migrationMessage,
  startupWarning,
  credentialCases,
  credentialSeed,
  credentialRowsQuery,
  assertCredentialRows,
  expectedMigration,
} from "./worker-credential-reconnect-fixtures.mjs";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "postgres" },
    profile: { type: "string", default: "accounts" },
    kind: { type: "string", default: "both" },
    production: { type: "boolean", default: false },
    timeouts: { type: "boolean", default: false },
    "query-failure": { type: "boolean", default: false },
    shutdown: { type: "boolean", default: false },
    report: { type: "string" },
  },
});
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(values.database));
assert.ok(["none", "password", "accounts"].includes(values.profile));
assert.ok(["both", "node", "rust"].includes(values.kind));
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-worker-credential-reconnect-"),
);
console.error(JSON.stringify({ event: "credential-reconnect.created", root }));
const report = { root, ...values, peers: [], completeReplacement: false };
const cases = credentialCases(values.timeouts),
  byId = new Map(cases.map((c) => [c.id, c]));
let pg, failure;
try {
  const passwordHash =
    values.profile === "password" ? await hashPassword(password) : undefined;
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const kind of values.kind === "both"
    ? ["node", "rust"]
    : [values.kind]) {
    const databaseUrl =
      pg && (kind === "node" || values.database === "postgres")
        ? await pg.database()
        : undefined;
    const f = new HttpFixture({
      kind,
      root,
      name: values.profile,
      databaseMode: values.database,
      executable: process.env.CANTRIP_RUST_SERVER_BINARY,
      liveSqlFixture: !values.production,
      environment: {
        CANTRIP_AUTH_MODE: values.profile,
        CANTRIP_REGISTRATION_ENABLED: "true",
        CANTRIP_SESSION_TTL_SECONDS: "3600",
        CANTRIP_FIXTURE_LOGGING: "true",
        ...(passwordHash ? { CANTRIP_PASSWORD_HASH: passwordHash } : {}),
        ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
        ...(kind === "rust" && values.database === "bundled-postgres"
          ? {
              CANTRIP_POSTGRES_BIN_DIR:
                process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
            }
          : {}),
      },
    });
    const result = {
      kind,
      http: [],
      commands: [],
      summaries: [],
      stages: [],
      background: [],
      disconnects: 0,
      rawServerLines: [],
    };
    report.peers.push(result);
    let worker,
      server,
      observer,
      round = 0;
    const lines = [],
      purged = new Set();
    const visit = async (label, method, url, options = {}) => {
      result.http.push({
        label,
        ...(await f.observe(label, method, url, { csrf: true, ...options })),
      });
      return f.records.get(label);
    };
    const rows = async () => (await f.sql([], [credentialRowsQuery]))[0];
    const validateCommand = (command) => {
      const c = byId.get(command.providerAccountId);
      assert.ok(c);
      assert.equal(command.providerId, c.provider);
      assert.equal(command.providerKind, c.kind);
      assert.equal(command.credentialHomeKey, c.home);
      assert.ok(!["foreign", "signed-out"].includes(c.name));
      result.commands.push({ round, command, receivedAt: Date.now() });
      return c;
    };
    const handler = {
      "model.ollama.catalog": async () => ({
        models: [],
        observedAt: new Date().toISOString(),
      }),
      "provider.auth.legacy.capture": async (command) => {
        const c = validateCommand(command);
        if (purged.has(c.id) || c.name === "missing")
          return { status: "missing" };
        if (c.name === "malformed") return { status: "malformed" };
        if (c.name === "invalid")
          return {
            status: "available",
            credential: c.captured,
            metadata: { expiresAt: privateMarker },
          };
        if (c.name === "error") throw new Error(privateMarker);
        if (c.name === "deadline") return new Promise(() => {});
        return {
          status: "available",
          credential: c.captured,
          metadata: { expiresAt: null },
          portableAuth: c.name !== "nonportable",
        };
      },
      "provider.auth.legacy.purge": async (command) => {
        const c = validateCommand(command);
        // Observe the real committed row at the moment the worker is asked to purge.
        const stored = (await rows()).find((r) => r.id === c.id);
        assert.equal(stored.state, "signed-in");
        assert.equal(stored.subject, command.expectedSubjectBlindIndex);
        assert.equal(stored.revision, command.serverCredentialRevision);
        assert.deepEqual(
          stored.credential,
          c.initial?.protectedCredential ?? c.captured.protectedCredential,
        );
        if (c.name === "purge-failure" && round === 1)
          throw new Error(privateMarker);
        purged.add(c.id);
        return {
          purged: true,
          subjectBlindIndex: command.expectedSubjectBlindIndex,
          serverCredentialRevision: command.serverCredentialRevision,
        };
      },
    };
    try {
      if (values.production) {
        assert.ok(
          databaseUrl,
          "Observe only the isolated external PostgreSQL fixture",
        );
        const postgres = createRequire(
          new URL(
            "../../tests/reference-node-server/package.json",
            import.meta.url,
          ),
        )("postgres");
        observer = postgres(databaseUrl, { max: 1 });
        f.sql = (statements, queries = []) =>
          observer.begin(async (sql) => {
            for (const statement of statements) await sql.unsafe(statement);
            const results = [];
            for (const query of queries) {
              const data = await sql.unsafe(query);
              assert.equal(data.length, 1);
              results.push(JSON.parse(data[0].result));
            }
            return results;
          });
      }
      await f.start();
      server = f.server;
      const observeLogs = () => {
        for (const stream of [server.child.stdout, server.child.stderr]) {
          const input = createInterface({ input: stream });
          lines.push(input);
          input.on("line", (line) => {
            result.rawServerLines.push(line);
            let message;
            try {
              message = JSON.parse(line);
            } catch {
              // The reference's production formatter flattens public context;
              // observe those actual counter fields instead of replacing its logger.
              const text = [migrationMessage, startupWarning].find(
                (text) => line.startsWith("[server]") && line.includes(text),
              );
              if (text) {
                const worker = /\bworkerId=(\S+)/.exec(line)?.[1];
                const counters = [
                  ...line.matchAll(/\bmigration\.([A-Za-z]+)=(\d+)/g),
                ];
                const migration =
                  text === migrationMessage
                    ? Object.fromEntries(
                        counters.map(([, key, value]) => [key, Number(value)]),
                      )
                    : null;
                result.summaries.push({
                  round,
                  message: text,
                  worker,
                  migration,
                  level: text === migrationMessage ? "info" : "warn",
                });
              }
              return;
            }
            const text = message.msg ?? message.message;
            if (![migrationMessage, startupWarning].includes(text)) return;
            const context = message.context ?? message;
            result.summaries.push({
              round,
              message: text,
              worker: context.workerId,
              migration: context.migration ?? null,
              level:
                typeof message.level === "number"
                  ? message.level === 30
                    ? "info"
                    : "warn"
                  : message.level,
            });
          });
        }
      };
      observeLogs();
      const auth =
        values.profile === "accounts"
          ? await visit("register", "POST", "/api/auth/register", {
              status: 201,
              json: {
                email: "credential-reconnect@example.invalid",
                displayName: "Credential owner",
                password,
              },
            })
          : values.profile === "password"
            ? await visit("login", "POST", "/api/auth/login", {
                json: { password },
              })
            : await visit("session", "GET", "/api/auth/session");
      const owner = auth.currentUser?.id ?? localOwner,
        foreign = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      if (values.production) {
        await visit("fixture SQL absent", "POST", "/__fixture/sql", {
          status: 404,
          json: { statements: [] },
        });
        result.productionSqlControlStatus = 404;
      }
      worker = await managementWorker({
        f,
        visit,
        root: path.join(root, values.profile, kind, "worker"),
        state: result,
        handlers: handler,
      });
      worker.close();
      await eventually(
        () => worker.connected,
        (v) => assert.equal(v, false),
      );
      await delay(150);
      await f.sql(credentialSeed(cases, owner, foreign));
      for (round = 1; round <= (values.timeouts ? 1 : 2); round++) {
        const started = Date.now();
        await worker.start();
        result.stages.push({ round, readyMs: Date.now() - started });
        await eventually(
          () =>
            result.summaries.filter(
              (s) => s.round === round && s.message === migrationMessage,
            ),
          (v) => assert.equal(v.length, 1),
          values.timeouts ? 22000 : 10000,
        );
        const summary = result.summaries.find(
          (s) => s.round === round && s.message === migrationMessage,
        );
        assert.deepEqual(summary, {
          round,
          message: migrationMessage,
          worker: "alpha",
          migration: expectedMigration(round, values.timeouts),
          level: "info",
        });
        const saved = await rows();
        assertCredentialRows(saved, cases);
        result.stages.at(-1).rows = saved;
        if (values.timeouts) {
          const deadline = result.commands.find(
            (c) =>
              c.command.providerAccountId ===
              cases.find((c) => c.name === "deadline").id,
          );
          assert.ok(
            Date.now() - deadline.receivedAt >= 15000,
            "Actual fifteen-second capture deadline",
          );
        }
        worker.close();
        await eventually(
          () => worker.connected,
          (v) => assert.equal(v, false),
        );
        await delay(150);
      }
      if (values["query-failure"]) {
        round = 3;
        await f.sql([
          "ALTER TABLE model_provider_accounts RENAME TO owned_credential_reconnect_unavailable",
        ]);
        try {
          await worker.start({ heartbeat: false });
          await eventually(
            () => result.summaries.filter((s) => s.round === round),
            (records) =>
              assert.deepEqual(records, [
                {
                  round,
                  message: startupWarning,
                  worker: "alpha",
                  migration: null,
                  level: "warn",
                },
              ]),
          );
          assert.equal(
            result.commands.filter((c) => c.round === round).length,
            0,
          );
        } finally {
          worker.close();
          await eventually(
            () => worker.connected,
            (connected) => assert.equal(connected, false),
          );
          await f.sql([
            "ALTER TABLE owned_credential_reconnect_unavailable RENAME TO model_provider_accounts",
          ]);
        }
        round = 4;
        await worker.start();
        await eventually(
          () => result.summaries.filter((s) => s.round === round),
          (records) =>
            assert.deepEqual(records, [
              {
                round,
                message: migrationMessage,
                worker: "alpha",
                level: "info",
                migration: {
                  alreadyCaptured: 1,
                  captured: 0,
                  checked: 10,
                  conflicts: 0,
                  failed: 2,
                  malformed: 1,
                  missing: 6,
                  purged: 0,
                },
              },
            ]),
        );
        const saved = await rows();
        assertCredentialRows(saved, cases);
        result.stages.push({ round, rows: saved });
      }
      if (values.shutdown) {
        const target = {
          name: "shutdown",
          id: "99999999-9999-4999-8999-000000000099",
          provider: "credential-reconnect-chatgpt",
          kind: "chatgpt",
          home: "shutdown-home",
          captured: capturedCredentialFixture(151),
          initial: null,
        };
        byId.set(target.id, target);
        await credentialReconnectShutdown({
          f,
          server,
          result,
          target,
          reconnect: async () => {
            worker.close();
            await eventually(
              () => worker.connected,
              (connected) => assert.equal(connected, false),
            );
            await delay(150);
            round = 5;
            await worker.start();
          },
          restart: async () => {
            worker.close();
            const port = Number(new URL(server.origin).port);
            await f.start({ port });
            server = f.server;
            observeLogs();
            round = 6;
            await worker.start();
          },
        });
        await eventually(
          () => result.summaries.filter((s) => s.round === 6),
          (records) =>
            assert.deepEqual(records, [
              {
                round: 6,
                message: migrationMessage,
                worker: "alpha",
                level: "info",
                migration: {
                  alreadyCaptured: 2,
                  captured: 0,
                  checked: 11,
                  conflicts: 0,
                  failed: 2,
                  malformed: 1,
                  missing: 6,
                  purged: 1,
                },
              },
            ]),
        );
        const recovered = await rows();
        assertCredentialRows(
          recovered.filter((row) => row.id !== target.id),
          cases,
        );
        result.stages.push({ round, rows: recovered });
      }
      result.passed = true;
    } finally {
      worker?.close();
      try {
        await f.close();
      } finally {
        if (server) {
          result.diagnostics = server.diagnostics();
          result.exit = {
            code: server.child.exitCode,
            signal: server.child.signalCode,
          };
        }
        for (const input of lines) input.close();
        await observer?.end({ timeout: 5 });
      }
    }
    assert.deepEqual(result.exit, { code: 0, signal: null });
    assert.ok(
      !result.rawServerLines.join("\n").includes(privateMarker),
      "Server logs retain counters, never private worker error/response contents",
    );
  }
  if (report.peers.length === 2) {
    const [source, native] = report.peers;
    assert.deepEqual(native.http, source.http);
    assert.deepEqual(native.summaries, source.summaries);
    assert.deepEqual(
      native.commands.map(({ round, command }) => ({ round, command })),
      source.commands.map(({ round, command }) => ({ round, command })),
    );
    assert.deepEqual(
      native.stages.map(({ round, rows }) => ({ round, rows })),
      source.stages.map(({ round, rows }) => ({ round, rows })),
    );
    if (values.shutdown) {
      assert.deepEqual(native.shutdown, source.shutdown);
      assert.deepEqual(native.restart, source.restart);
    }
    report.paired = {
      http: source.http.length,
      commands: source.commands.length,
      summaries: source.summaries.length,
      stages: source.stages.length,
    };
  }
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await pg?.close();
  if (values.report)
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
}
if (failure) throw failure;
console.log(JSON.stringify({ passed: true, root, paired: report.paired }));
