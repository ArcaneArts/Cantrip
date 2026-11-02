// Actual production HTTP routes and Live subscriptions on isolated stores.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { literal } from "./project-target-state.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");

async function abortedUpdate(fixture, url, id, version) {
  const blocker = postgres(url, { max: 1 }),
    observer = postgres(url, { max: 1 });
  const controller = new AbortController();
  let release, locked, held, pending;
  const acquired = new Promise((resolve) => (locked = resolve)),
    gate = new Promise((resolve) => (release = resolve));
  async function wait(read, predicate, label) {
    const deadline = Date.now() + 20000;
    let value;
    do {
      value = await read();
      if (predicate(value)) return value;
      await delay(20);
    } while (Date.now() < deadline);
    assert.ok(predicate(value), label + JSON.stringify(value));
  }
  try {
    held = blocker.begin(async (sql) => {
      await sql`SELECT id FROM task_workers WHERE id=${id} FOR UPDATE`;
      locked();
      await gate;
    });
    await Promise.race([
      acquired,
      held.then(() => {
        throw new Error(
          "Task Worker HTTP blocker exited before acquiring lock",
        );
      }),
    ]);
    const client = fixture.client();
    pending = fetch(fixture.server.origin + route + "/" + id, {
      method: "PATCH",
      signal: controller.signal,
      headers: {
        origin: "http://127.0.0.1:5173",
        "content-type": "application/json",
        ...(client.cookies.size
          ? {
              cookie: [...client.cookies]
                .map(([k, v]) => `${k}=${v}`)
                .join("; "),
            }
          : {}),
        ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
      },
      body: JSON.stringify({
        rowVersion: version,
        name: "Aborted caller committed",
      }),
    });
    pending.catch(() => {});
    const witnesses = await wait(
      () =>
        observer`SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND query ILIKE '%task_workers%' AND query ILIKE '%UPDATE%' AND wait_event_type='Lock'`,
      (rows) => rows.length === 1,
      "Actual HTTP mutation waiting on row lock",
    );
    controller.abort();
    await assert.rejects(pending, (error) => error.name === "AbortError");
    release();
    await held;
    const [row] = await wait(
      () => observer`SELECT name,row_version FROM task_workers WHERE id=${id}`,
      (rows) => rows[0]?.row_version === version + 1,
      "Admitted HTTP mutation survives caller abort",
    );
    assert.equal(row.name, "Aborted caller committed");
    return { witnesses, row };
  } finally {
    controller.abort();
    release();
    await held?.catch(() => {});
    await pending?.catch(() => {});
    await Promise.all([blocker.end(), observer.end()]);
  }
}

const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-task-workers-http-"));
const report = {
  suite: "actual-task-workers-http-live",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
const route = "/api/settings/task-workers";
let pg, active, failure;
try {
  const executable = await buildRustServer(),
    repositoryExecutable = await buildRustExample("project-repository-fixture"),
    passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !option("--profile") || p === option("--profile"),
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const fixture = (active = new HttpFixture({
        kind,
        executable,
        root,
        name: profile,
        databaseMode,
        environment: {
          CANTRIP_AUTH_MODE: profile,
          CANTRIP_REGISTRATION_ENABLED: "true",
          CANTRIP_SESSION_TTL_SECONDS: "3600",
          ...(profile === "password"
            ? { CANTRIP_PASSWORD_HASH: passwordHash }
            : {}),
          ...(url ? { DATABASE_URL: url } : {}),
          ...(kind === "rust" && databaseMode === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      }));
      const result = { kind, observations: [], live: [], persistence: [] };
      outputs.push(result);
      let repository, live, otherLive;
      const visit = async (label, method, target, options = {}) => {
        const observation = await fixture.observe(label, method, target, {
          csrf:
            !["GET", "HEAD", "OPTIONS"].includes(method) &&
            !!fixture.client(options.client).csrf,
          ...options,
        });
        result.observations.push({ label, ...observation });
        return fixture.records.get(label);
      };
      const openRepository = () =>
        repositoryFixture({
          kind,
          executable: repositoryExecutable,
          root: path.join(root, profile),
          databaseMode,
          databaseUrl: url,
        });
      try {
        await fixture.start();
        if (profile !== "none") {
          await visit("anonymous list denied", "GET", route, {
            client: "anonymous",
            status: 401,
          });
          await visit("anonymous create denied", "POST", route, {
            client: "anonymous",
            json: {},
            status: 401,
          });
        }
        if (profile === "accounts") {
          for (const client of ["main", "other"])
            await visit("register " + client, "POST", "/api/auth/register", {
              client,
              status: 201,
              json: {
                email: `task-workers-${client}@example.invalid`,
                displayName: "Task Workers " + client,
                password,
              },
            });
        } else {
          await visit("session", "GET", "/api/auth/session");
          if (profile === "password")
            await visit("login", "POST", "/api/auth/login", {
              json: { password },
            });
        }
        const owner =
          profile === "accounts"
            ? fixture.records.get("register main").currentUser.id
            : "00000000-0000-0000-0000-000000000001";
        const other =
          profile === "accounts"
            ? fixture.records.get("register other").currentUser.id
            : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        await fixture.close();
        repository = await openRepository();
        if (profile !== "accounts")
          await repository.seed(
            `INSERT INTO users(id,kind,role,status,email,normalized_email,display_name) VALUES(${literal(other)},'account','member','active','foreign-task-worker@example.invalid','foreign-task-worker@example.invalid','Foreign')`,
          );
        for (const sql of [
          `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('http-tw-provider',${literal(owner)},'Provider','openai-compatible','http://fixture.invalid')`,
          `INSERT INTO model_profiles(id,owner_id,name) VALUES('http-tw-root',${literal(owner)},'Root'),('http-tw-sub',${literal(owner)},'Sub'),('http-tw-foreign',${literal(other)},'Foreign')`,
          "INSERT INTO provider_models(id,provider_id,native_model_id,display_name,family,metadata_source) VALUES('http-tw-catalog','http-tw-provider','root','Root',' ＧＰＴ　５.４ ','codex')",
          "INSERT INTO model_routes(id,model_id,provider_id,provider_model_id,model_name,position) VALUES('http-tw-route','http-tw-root','http-tw-provider','http-tw-catalog','root',0),('http-tw-sub-route','http-tw-sub','http-tw-provider',NULL,'sub',0)",
          "CREATE FUNCTION task_worker_http_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name='projection-invalid' THEN NEW.continuity_family='INVALID'; END IF; RETURN NEW; END $$",
          "CREATE TRIGGER task_worker_http_projection BEFORE INSERT OR UPDATE ON task_workers FOR EACH ROW EXECUTE FUNCTION task_worker_http_projection()",
          "ALTER TABLE task_workers ADD CONSTRAINT task_worker_http_failure CHECK (name <> 'sql-rejected')",
        ])
          await repository.seed(sql);
        await repository.close();
        repository = null;
        await fixture.start();
        live = await new LiveProbe(fixture).open();
        await live.initialized();
        await live.subscribed();
        if (profile === "accounts") {
          otherLive = await new LiveProbe(fixture, { client: "other" }).open();
          await otherLive.initialized();
          await otherLive.subscribed();
        }
        await visit("empty worker list", "GET", route);
        await visit("HEAD worker list", "HEAD", route);
        const configuration = { modelId: "http-tw-root" };
        for (const [label, json] of [
          ["missing create fields", {}],
          [
            "strict create unknown field",
            { name: "A", modelConfiguration: configuration, extra: true },
          ],
          [
            "create null root",
            { name: "A", modelConfiguration: { modelId: null } },
          ],
          [
            "invalid concurrency",
            {
              name: "A",
              modelConfiguration: configuration,
              maxConcurrency: 65,
            },
          ],
          [
            "invalid family",
            {
              name: "A",
              modelConfiguration: configuration,
              continuityFamilyOverride: "UPPER",
            },
          ],
        ])
          await visit(label, "POST", route, { json, status: 400 });
        for (const modelId of ["http-tw-foreign", "missing"])
          await visit("unavailable model " + modelId, "POST", route, {
            json: { name: "Unavailable", modelConfiguration: { modelId } },
            status: 409,
          });
        if (profile !== "none")
          await visit("missing CSRF denied", "POST", route, {
            csrf: false,
            json: { name: "No CSRF", modelConfiguration: configuration },
            status: 403,
          });
        const first = await visit("create first", "POST", route, {
          status: 201,
          json: { name: " First ", modelConfiguration: configuration },
        });
        assert.equal(first.name, "First");
        assert.equal(first.continuityFamily, "gpt-5.4");
        assert.equal(first.rowVersion, 1);
        await visit("actual SQL create failure", "POST", route, {
          json: { name: "sql-rejected", modelConfiguration: configuration },
          status: 500,
        });
        const second = await visit("create second", "POST", route, {
          status: 201,
          json: {
            name: "Second",
            enabled: false,
            maxConcurrency: 4,
            allowsPlanGoal: true,
            continuityFamilyOverride: "custom-family",
            modelConfiguration: {
              ...configuration,
              customSubagentModel: true,
              subagentModelId: "http-tw-sub",
            },
          },
        });
        for (const [label, json] of [
          ["empty update", { rowVersion: 1 }],
          ["strict update", { rowVersion: 1, name: "A", unknown: true }],
          [
            "null configuration update",
            { rowVersion: 1, modelConfiguration: null },
          ],
        ])
          await visit(label, "PATCH", `${route}/${first.id}`, {
            json,
            status: 400,
          });
        if (profile === "accounts") {
          await visit("foreign list empty", "GET", route, { client: "other" });
          await visit(
            "foreign update denied",
            "PATCH",
            `${route}/${first.id}`,
            {
              client: "other",
              json: { rowVersion: 1, name: "Stolen" },
              status: 404,
            },
          );
          await visit(
            "foreign delete denied",
            "DELETE",
            `${route}/${first.id}`,
            { client: "other", json: { rowVersion: 1 }, status: 404 },
          );
          await visit("foreign reorder denied", "PUT", `${route}/order`, {
            client: "other",
            json: { ids: [first.id, second.id] },
            status: 409,
          });
        }
        await visit("missing worker update", "PATCH", `${route}/missing`, {
          json: { rowVersion: 1, name: "Missing" },
          status: 404,
        });
        await visit(
          "update preserves false and null",
          "PATCH",
          `${route}/${first.id}`,
          {
            json: {
              rowVersion: 1,
              enabled: false,
              allowsPlanGoal: false,
              maxConcurrency: 2,
              continuityFamilyOverride: null,
            },
          },
        );
        await visit("stale update", "PATCH", `${route}/${first.id}`, {
          json: { rowVersion: 1, name: "Stale" },
          status: 409,
        });
        await visit("stale delete", "DELETE", `${route}/${first.id}`, {
          json: { rowVersion: 1 },
          status: 409,
        });
        await visit(
          "actual SQL update failure",
          "PATCH",
          `${route}/${first.id}`,
          { json: { rowVersion: 2, name: "sql-rejected" }, status: 500 },
        );
        await visit(
          "actual SQL delete integer overflow",
          "DELETE",
          `${route}/${first.id}`,
          { json: { rowVersion: 2147483648 }, status: 500 },
        );
        await visit("DELETE requires body", "DELETE", `${route}/${first.id}`, {
          status: 400,
        });
        await visit("DELETE strict body", "DELETE", `${route}/${first.id}`, {
          json: { rowVersion: 2, extra: 1 },
          status: 400,
        });
        await visit("duplicate order IDs rejected", "PUT", `${route}/order`, {
          json: { ids: [first.id, first.id] },
          status: 400,
        });
        await visit("incomplete order conflict", "PUT", `${route}/order`, {
          json: { ids: [first.id] },
          status: 409,
        });
        if (databaseMode === "postgres") {
          result.abortedWrite = await abortedUpdate(fixture, url, first.id, 2);
          await visit("read committed caller-aborted update", "GET", route);
        }
        const reordered = await visit(
          "reorder all workers",
          "PUT",
          `${route}/order`,
          { json: { ids: [second.id, first.id] } },
        );
        assert.deepEqual(
          reordered.map((w) => w.id),
          [second.id, first.id],
        );
        await visit(
          "PATCH order resolves worker ID",
          "PATCH",
          `${route}/order`,
          { json: { rowVersion: 1, name: "Order worker" }, status: 404 },
        );
        await visit(
          "DELETE order resolves worker ID",
          "DELETE",
          `${route}/order`,
          { json: { rowVersion: 1 }, status: 404 },
        );
        await visit("GET order is absent", "GET", `${route}/order`, {
          status: 404,
        });
        await visit("POST order is absent", "POST", `${route}/order`, {
          json: {},
          status: 404,
        });
        await visit("delete first", "DELETE", `${route}/${first.id}`, {
          json: { rowVersion: databaseMode === "postgres" ? 4 : 3 },
          status: 204,
        });
        await visit(
          "repeat delete not found",
          "DELETE",
          `${route}/${first.id}`,
          { json: { rowVersion: 3 }, status: 404 },
        );
        await visit("list omits deleted", "GET", route);
        await live.ping();
        if (otherLive) await otherLive.ping();
        const events = live.history.filter(
          (f) => f.type === "event" && f.resource === "settings",
        );
        assert.equal(
          events.length,
          databaseMode === "postgres" ? 6 : 5,
          "Only committed successful mutations publish settings invalidations",
        );
        result.live = events.map(({ resource, action, entityId, scope }) =>
          fixture.normalize({ resource, action, entityId, scope }),
        );
        if (otherLive)
          assert.deepEqual(
            otherLive.history.filter(
              (f) => f.type === "event" && f.resource === "settings",
            ),
            [],
            "Foreign owner receives no settings events",
          );
        await live.close();
        live = null;
        await otherLive?.close();
        otherLive = null;
        await visit(
          "projection failure follows committed write",
          "POST",
          route,
          {
            json: {
              name: "projection-invalid",
              modelConfiguration: configuration,
            },
            status: 500,
          },
        );
        await visit(
          "invalid committed row fails list projection",
          "GET",
          route,
          { status: 500 },
        );
        await fixture.close();
        repository = await openRepository();
        const state = await repository.request({
          op: "query-json",
          sql: "SELECT jsonb_build_object('count',count(*),'deleted',count(*) FILTER (WHERE deleted_at IS NOT NULL),'invalid',count(*) FILTER (WHERE continuity_family='INVALID'),'deletedDisabled',bool_and(deleted_at IS NULL OR NOT enabled)) result FROM task_workers",
        });
        assert.equal(state.rejected, false, state.diagnostic);
        assert.deepEqual(state.value, {
          count: 3,
          deleted: 1,
          invalid: 1,
          deletedDisabled: true,
        });
        result.persistence.push(state.value);
        await repository.close();
        repository = null;
        await fixture.start();
        await visit(
          "invalid committed row persists across restart",
          "GET",
          route,
          { status: 500 },
        );
      } finally {
        await live?.close();
        await otherLive?.close();
        await fixture.close();
        await repository?.close();
        active = null;
      }
    }
    assert.deepEqual(
      outputs[1].observations,
      outputs[0].observations,
      profile + " actual HTTP response compatibility",
    );
    assert.deepEqual(
      outputs[1].live,
      outputs[0].live,
      profile + " actual Live compatibility",
    );
    assert.deepEqual(
      outputs[1].persistence,
      outputs[0].persistence,
      profile + " durable SQL compatibility",
    );
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.passed = false;
  report.error = error.stack ?? String(error);
} finally {
  await active?.close();
  await pg?.close();
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    profiles: report.profiles.map((p) => ({
      profile: p.profile,
      observations: p.outputs[0].observations.length,
    })),
    passed: report.passed,
  }),
);
