// Real connections and production refresh producers; worker provider replies are controlled.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { managementWorker } from "./worker-management-http-worker.mjs";
import { eventually } from "./full-worker.mjs";
import { policyEnvelope } from "./policy-wire-fixtures.mjs";
import {
  capturedCredentialFixture,
  quotaSnapshot,
} from "./settings-provider-fixtures.mjs";
import { literal, localOwner } from "./project-target-state.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import { compareCatalogRefresh } from "./worker-catalog-refresh-observations.mjs";
import { catalogRefreshShutdown } from "./worker-catalog-refresh-shutdown.mjs";

const { values } = parseArgs({
  options: {
    kind: { type: "string", default: "both" },
    database: { type: "string", default: "postgres" },
    profile: { type: "string", default: "accounts" },
    periodic: { type: "boolean", default: false },
    production: { type: "boolean", default: false },
    shutdown: { type: "boolean", default: false },
    report: { type: "string" },
  },
});
assert.ok(["node", "rust", "both"].includes(values.kind));
assert.ok(["none", "password", "accounts"].includes(values.profile));
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(values.database));
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-worker-catalog-refresh-"),
);
const report = { root, ...values, peers: [], completeReplacement: false };
console.error(JSON.stringify({ event: "catalog-refresh.created", root }));
const account = (n) => "88888888-8888-4888-8888-" + String(n).padStart(12, "0");
const credential = capturedCredentialFixture(82);
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
      commands: [],
      http: [],
      stages: [],
      background: [],
      disconnects: 0,
    };
    report.peers.push(result);
    let worker, pulse, server, heartbeatFailure, observer;
    if (values.production) {
      assert.ok(
        databaseUrl,
        "Observe only the fixture-owned external PostgreSQL database",
      );
      const postgres = createRequire(
        new URL("../../cantrip_server/package.json", import.meta.url),
      )("postgres");
      observer = postgres(databaseUrl, { max: 1 });
      f.sql = (statements, queries = []) =>
        observer.begin(async (sql) => {
          for (const statement of statements) await sql.unsafe(statement);
          const results = [];
          for (const query of queries) {
            const rows = await sql.unsafe(query);
            assert.equal(rows.length, 1);
            results.push(JSON.parse(rows[0].result));
          }
          return results;
        });
    }
    const visit = async (label, method, url, options = {}) => {
      result.http.push({
        label,
        ...(await f.observe(label, method, url, { csrf: true, ...options })),
      });
      return f.records.get(label);
    };
    const rows = async () =>
      (
        await f.sql(
          [],
          [
            "SELECT coalesce(jsonb_agg(jsonb_build_object('account',provider_account_id,'trigger',observation_trigger,'worker',worker_id,'owner',owner_id,'batch',observation_batch_key) ORDER BY observation_trigger,provider_account_id,observation_batch_key),'[]'::jsonb)::text result FROM provider_quota_observations WHERE provider_id LIKE 'refresh-%'",
          ],
        )
      )[0];
    let sequence = 0,
      phase = "initial";
    const capture = async (command) => {
      result.commands.push({
        phase,
        elapsedMs: Date.now() - result.startedAt,
        command,
      });
      if (command.provider.id === "refresh-failure")
        throw new Error("Controlled catalog failure");
      if (
        phase === "quota-failure" &&
        command.type === "provider.quota.read" &&
        command.provider.accountId === account(2)
      )
        throw new Error("Controlled quota failure");
      if (command.type === "provider.quota.read")
        return {
          ...structuredClone(quotaSnapshot),
          observedAt: new Date().toISOString(),
          snapshotId: "refresh-" + ++sequence,
        };
      return { models: [], observedAt: new Date().toISOString() };
    };
    const tracked = (stage) =>
      result.commands.filter(
        (c) =>
          c.phase === stage && c.command.provider.id.startsWith("refresh-"),
      );
    const quotaAccounts = (stage) =>
      tracked(stage)
        .filter((c) => c.command.type === "provider.quota.read")
        .map((c) => c.command.provider.accountId)
        .sort();
    const closeWorker = async () => {
      worker.close();
      await eventually(
        () => worker.connected,
        (v) => assert.equal(v, false),
      );
      await delay(150);
    };
    try {
      result.startedAt = Date.now();
      await f.start();
      server = f.server;
      const auth =
        values.profile === "accounts"
          ? await visit("register", "POST", "/api/auth/register", {
              status: 201,
              json: {
                email: "refresh@example.invalid",
                displayName: "Refresh owner",
                password: "isolated refresh fixture password",
              },
            })
          : values.profile === "password"
            ? await visit("login", "POST", "/api/auth/login", {
                json: { password },
              })
            : await visit("session", "GET", "/api/auth/session");
      if (values.production) {
        await visit("fixture SQL absent", "POST", "/__fixture/sql", {
          status: 404,
          json: { statements: [] },
        });
        result.productionSqlControlStatus = 404;
      }
      const owner = auth.currentUser?.id ?? localOwner;
      const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      worker = await managementWorker({
        f,
        visit,
        root: path.join(root, values.profile, kind, "worker"),
        state: result,
        handlers: Object.fromEntries(
          [
            "model.ollama.catalog",
            "model.endpoint.catalog",
            "model.chatgpt.catalog",
            "model.grok.catalog",
            "provider.quota.read",
          ].map((t) => [t, capture]),
        ),
      });
      pulse = setInterval(() => {
        worker.pulse().catch((e) => {
          heartbeatFailure = e;
        });
      }, 15000);
      await closeWorker();
      const statements = [
        `INSERT INTO users(id,kind,email,normalized_email,display_name) VALUES(${literal(other)},'account','foreign-refresh@example.invalid','foreign-refresh@example.invalid','Foreign owner')`,
      ];
      for (const [id, family, who] of [
        ["refresh-ollama", "ollama", owner],
        ["refresh-failure", "ollama", owner],
        ["refresh-account", "chatgpt", owner],
        ["refresh-grok", "grok", owner],
        ["refresh-foreign", "chatgpt", other],
      ]) {
        statements.push(
          `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES(${literal(id)},${literal(who)},${literal(id)},${literal(family)},'http://127.0.0.1:11434')`,
        );
      }
      for (const [n, provider, enabled] of [
        [1, "refresh-account", true],
        [2, "refresh-account", true],
        [3, "refresh-account", false],
        [4, "refresh-grok", true],
        [5, "refresh-foreign", true],
      ]) {
        statements.push(
          `INSERT INTO model_provider_accounts(id,provider_id,protected_label,credential_home_key,position,enabled,credential_state,protected_credential,credential_revision,credential_subject_blind_index) VALUES(${literal(account(n))},${literal(provider)},${literal(JSON.stringify(policyEnvelope))},${literal(account(n))},${n},${enabled},'signed-in',${literal(JSON.stringify(credential.protectedCredential))},1,${literal(credential.subjectBlindIndex)})`,
        );
      }
      await f.sql(statements);
      // No provider grant: endpoint discovery still runs, account work does not.
      phase = "without-grant";
      await worker.start();
      await eventually(
        () => tracked(phase),
        (v) =>
          assert.ok(v.some((c) => c.command.provider.id === "refresh-ollama")),
      );
      await delay(350);
      assert.deepEqual(quotaAccounts(phase), []);
      assert.ok(
        tracked(phase).every(
          (c) =>
            !["model.chatgpt.catalog", "model.grok.catalog"].includes(
              c.command.type,
            ),
        ),
      );
      await closeWorker();
      worker.report.encryption = {
        supported: true,
        state: "ready",
        principalId: "33333333-3333-4333-8333-333333333333",
        grants: [{ component: "provider-credential", keyRevision: 1 }],
        lastSyncedAt: new Date().toISOString(),
        error: null,
      };
      await worker.pulse();
      phase = "reconnected";
      await worker.start();
      const expected = [account(1), account(2), account(4)];
      await eventually(rows, (v) =>
        assert.deepEqual(
          v
            .filter((r) => r.trigger === "worker-reconnected")
            .map((r) => r.account)
            .sort(),
          expected.flatMap((a) => [a, a]).sort(),
        ),
      );
      assert.deepEqual(quotaAccounts(phase), expected);
      assert.ok(
        tracked(phase).some((c) => c.command.provider.id === "refresh-failure"),
      );
      assert.equal(
        tracked(phase).filter((c) =>
          ["model.chatgpt.catalog", "model.grok.catalog"].includes(
            c.command.type,
          ),
        ).length,
        3,
      );
      result.stages.push({ phase, rows: await rows() });
      // Cached catalogs must not suppress the separate quota sweep.
      await closeWorker();
      phase = "cached-reconnect";
      await worker.start();
      await eventually(rows, (v) => assert.equal(v.length, 12));
      assert.deepEqual(quotaAccounts(phase), expected);
      assert.equal(
        tracked(phase).filter((c) =>
          ["model.chatgpt.catalog", "model.grok.catalog"].includes(
            c.command.type,
          ),
        ).length,
        0,
      );
      result.stages.push({ phase, rows: await rows() });
      // One failed quota request settles independently and the next connection retries it.
      await closeWorker();
      phase = "quota-failure";
      await worker.start();
      await eventually(rows, (v) => assert.equal(v.length, 16));
      assert.deepEqual(quotaAccounts(phase), expected);
      result.stages.push({ phase, rows: await rows() });
      await closeWorker();
      phase = "quota-recovered";
      await worker.start();
      await eventually(rows, (v) => assert.equal(v.length, 22));
      assert.deepEqual(quotaAccounts(phase), expected);
      result.stages.push({ phase, rows: await rows() });
      if (values.periodic) {
        phase = "periodic";
        console.error(
          JSON.stringify({
            event: "catalog-refresh.waiting-real-timer",
            kind,
            root,
            serverPid: server.child.pid,
            elapsedMs: Date.now() - result.startedAt,
          }),
        );
        await eventually(
          rows,
          (v) =>
            assert.equal(
              v.filter((r) => r.trigger === "periodic-refresh").length,
              6,
            ),
          930000,
        );
        const calls = tracked(phase).filter(
          (c) => c.command.type === "provider.quota.read",
        );
        assert.equal(calls.length, 3);
        assert.ok(
          calls.every((c) => c.elapsedMs >= 900000),
          "No shortened production timer",
        );
        result.stages.push({ phase, rows: await rows() });
      }
      assert.ok(
        result.commands.every(
          (c) => c.command.provider.id !== "refresh-foreign",
        ),
      );
      assert.ok(
        result.commands.every(
          (c) => c.command.provider.accountId !== account(3),
        ),
      );
      const persisted = await rows();
      assert.ok(
        persisted.every((r) => r.owner === owner && r.worker === "alpha"),
      );
      assert.equal(heartbeatFailure, undefined);
      if (values.shutdown) {
        clearInterval(pulse);
        await catalogRefreshShutdown({
          f,
          server,
          result,
          account: account(1),
          reconnect: async () => {
            await closeWorker();
            phase = "shutdown";
            await worker.start();
          },
        });
      }
      result.passed = true;
    } finally {
      clearInterval(pulse);
      worker?.close();
      try {
        await f.close();
      } finally {
        if (server) result.diagnostics = server.diagnostics();
        await observer?.end({ timeout: 5 });
      }
      result.exit = server && {
        code: server.child.exitCode,
        signal: server.child.signalCode,
      };
    }
    assert.deepEqual(result.exit, { code: 0, signal: null });
  }
  compareCatalogRefresh(report);
} catch (e) {
  failure = e;
  report.failure = { message: e.message, stack: e.stack };
} finally {
  if (pg) await pg.close();
  if (values.report)
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    passed: true,
    root,
    peers: report.peers.length,
    periodic: values.periodic,
  }),
);
