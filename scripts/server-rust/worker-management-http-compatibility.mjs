// Real HTTP/SQL/App Live and unchanged WorkerConnection, isolated per server.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  copyFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { managementWorker } from "./worker-management-http-worker.mjs";
import { managementReopen } from "./worker-management-http-reopen.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { eventually } from "./full-worker.mjs";
import {
  targetStateSql,
  localOwner,
  otherOwner,
  literal,
  json,
  stamp,
} from "./project-target-state.mjs";
import { heartbeat, password } from "./security-fixtures.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    profile: { type: "string" },
    report: { type: "string" },
    deadlines: { type: "boolean", default: true },
  },
});
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-worker-management-http-"),
);
process.stderr.write(
  JSON.stringify({ event: "worker-management.http.created", root }) + "\n",
);
const report = {
  root,
  database: values.database,
  profiles: [],
  completeReplacement: false,
  scope:
    "Production HTTP/SQL/Live/WorkerConnection with controlled restart effects; full supervisor, mixed Redis and supported-platform acceptance remains required",
};
const projects = {
  github: "11111111-1111-4111-8111-000000000001",
  folder: "11111111-1111-4111-8111-000000000002",
  "local-git": "11111111-1111-4111-8111-000000000003",
  other: "11111111-1111-4111-8111-000000000004",
};
const snapshotQuery =
  "SELECT jsonb_build_object('workers',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM workers w),'credentials',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM worker_credentials c),'codes',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM worker_enrollment_codes e),'sources',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM project_sources s),'projects',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM projects p),'settings',(SELECT jsonb_agg(to_jsonb(u) ORDER BY user_id) FROM user_settings u))::text AS result";
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function comparableSQL(raw, f) {
  const aliases = new Map();
  for (const [token, label] of [...f.workerCredentials, ...f.workerCodes])
    aliases.set(
      createHash("sha256").update(token).digest("hex"),
      "<sha256:" + label + ">",
    );
  const visit = (value, key = "") => {
    if (Array.isArray(value)) return value.map((v) => visit(v));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, visit(v, k)]),
      );
    if (typeof value !== "string") return value;
    if (["secret_hash", "code_hash"].includes(key)) {
      if (aliases.has(value)) return aliases.get(value);
      assert.ok(
        ["c".repeat(64), "d".repeat(64)].includes(value),
        "Every generated stored secret must match an actually issued credential/code",
      );
      return value;
    }
    if (/_at$/.test(key) && value) {
      assert.ok(Number.isFinite(Date.parse(value)), key);
      const iso = new Date(value).toISOString();
      if (iso === stamp) return stamp;
      if (key === "expires_at" && f.enrollmentExpirations.has(iso))
        return "<enrollment-code-expiry>";
      assert.ok(Date.parse(value) <= Date.now() + 1000, key);
      return "<database-timestamp>";
    }
    return f.normalize(value, key);
  };
  const normalized = visit(raw);
  // Snapshot row sets are keyed by proven normalized identity. Random issued
  // credential IDs can sort on either side of fixed seeded IDs in SQL.
  for (const rows of Object.values(normalized))
    if (Array.isArray(rows))
      rows.sort((a, b) =>
        String(a.id ?? a.user_id).localeCompare(String(b.id ?? b.user_id)),
      );
  return normalized;
}
async function run(f, profile, result) {
  const state = { commands: [], background: [], disconnects: 0 };
  let worker, live;
  const evidence = path.join(root, profile, f.kind, "observations");
  await mkdir(evidence, { recursive: true });
  const visit = async (name, method, url, options = {}) => {
    result.http.push({
      name,
      ...(await f.observe(name, method, url, { csrf: true, ...options })),
    });
    return f.records.get(name);
  };
  const snapshot = async () => (await f.sql([], [snapshotQuery]))[0];
  const settle = async (name, method, url, options = {}, changes = []) => {
    if (live) await live.ping(name + " before");
    const liveOffset = live?.frames.length ?? 0;
    const before = await snapshot(),
      offset = state.commands.length;
    const response = await visit(name, method, url, options),
      after = await snapshot();
    if (live) await live.ping(name + " after");
    const events = (live?.frames.slice(liveOffset) ?? [])
      .filter(
        (frame) =>
          frame.type === "event" &&
          ["worker", "worker-availability"].includes(frame.resource),
      )
      .map(({ cursor, ...event }) => f.normalize(event));
    const allowed = new Set(changes);
    for (const table of Object.keys(before))
      if (!allowed.has(table))
        assert.deepEqual(
          after[table],
          before[table],
          name + " preserves " + table,
        );
    if (allowed.has("workers")) {
      const id = decodeURIComponent(url.split("/").at(-1));
      assert.equal(after.workers.length, before.workers.length);
      for (const row of before.workers) {
        const current = after.workers.find((w) => w.id === row.id),
          expected = structuredClone(row);
        if (row.id === id)
          for (const field of method === "PATCH"
            ? ["display_name", "updated_at"]
            : ["unlinked_at", "updated_at"])
            expected[field] = current[field];
        assert.deepEqual(
          current,
          expected,
          name + " changes only the selected worker mutation fields",
        );
      }
    }
    const rawStatePath = path.join(
      evidence,
      String(result.cases.length).padStart(3, "0") + ".json",
    );
    await writeFile(
      rawStatePath,
      JSON.stringify({ before, after }, null, 2) + "\n",
    );
    result.cases.push({
      name,
      commands: state.commands.slice(offset),
      events,
      before: comparableSQL(before, f),
      after: comparableSQL(after, f),
      rawStatePath,
    });
    return response;
  };
  const management = (name) => settle(name, "GET", "/api/workers/management");
  try {
    await f.start();
    const authName =
      profile === "accounts"
        ? "register"
        : profile === "password"
          ? "login"
          : "session";
    const auth =
      profile === "accounts"
        ? await visit(authName, "POST", "/api/auth/register", {
            status: 201,
            json: {
              email: "management@example.invalid",
              displayName: "Management",
              password,
            },
          })
        : profile === "password"
          ? await visit(authName, "POST", "/api/auth/login", {
              json: { password },
            })
          : await visit(authName, "GET", "/api/auth/session");
    const owner = auth.currentUser?.id ?? localOwner;
    result.owner = owner;
    worker = await managementWorker({
      f,
      visit,
      root: path.join(root, profile, f.kind),
      state,
    });
    await f.sql([
      ...targetStateSql(owner, otherOwner, projects).filter(
        (sql) => !/^INSERT INTO workers.*VALUES\('alpha'/.test(sql),
      ),
      `UPDATE workers SET last_seen_at=${literal(stamp)} WHERE id<>'alpha'`,
      `UPDATE workers SET remote_surface_capabilities=${json(heartbeat.remoteSurfaces)} WHERE id<>'alpha'`,
      `UPDATE project_sources SET removed_at=${literal(stamp)} WHERE id='folder-beta'`,
      `INSERT INTO worker_credentials(id,worker_id,owner_id,secret_hash,scopes,expires_at,label,created_at,updated_at) VALUES('88888888-8888-4888-8888-000000000001','alpha',${literal(owner)},${literal("c".repeat(64))},'["worker:connect"]',${literal(stamp)},'Expired unrevoked',${literal(stamp)},${literal(stamp)})`,
      `INSERT INTO worker_credentials(id,worker_id,owner_id,secret_hash,scopes,revoked_at,revoked_reason,label,created_at,updated_at) VALUES('88888888-8888-4888-8888-000000000002','alpha',${literal(owner)},${literal("d".repeat(64))},'["worker:connect"]',${literal(stamp)},'historical','Revoked',${literal(stamp)},${literal(stamp)})`,
    ]);
    live = new LiveProbe(f);
    await live.opened;
    await live.initialized();
    await live.subscribed("management scopes");
    await live.ping("management baseline");
    live.frames = [];
    {
      const before = await snapshot(),
        client = f.client();
      const response = await fetch(f.server.origin + "/__fixture/sql", {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:5173",
          "content-type": "application/json",
          cookie: [...client.cookies].map(([k, v]) => k + "=" + v).join("; "),
          ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
        },
        body: JSON.stringify({
          statements: [
            `INSERT INTO project_sources(id,project_id,worker_id,source_kind,absolute_path,display_path) VALUES('foreign-on-alpha',${literal(projects.other)},'alpha','git','/foreign','/foreign')`,
          ],
          queries: [],
        }),
        signal: AbortSignal.timeout(15000),
      });
      const body = await response.text();
      result.constraintProbe = { status: response.status, body };
      assert.equal(response.status, 500);
      if (f.kind === "node") {
        assert.equal(JSON.parse(body).error, "Internal server error.");
        assert.ok(
          f.server
            .diagnostics()
            .includes("source project and worker must share an owner"),
        );
      } else
        assert.ok(
          body.includes("source project and worker must share an owner"),
          body,
        );
      const after = await snapshot();
      assert.deepEqual(after, before);
      // This development SQL control has implementation-specific diagnostics;
      // it is not a production HTTP contract. Both actual constraints must fail.
      await writeFile(
        path.join(evidence, "cross-owner-constraint.json"),
        JSON.stringify({ before, after, ...result.constraintProbe }, null, 2) +
          "\n",
      );
    }
    const records = await management("owned management catalog"),
      alpha = records.find((w) => w.workerId === "alpha"),
      beta = records.find((w) => w.workerId === "beta");
    assert.equal(alpha.runtimeName, "alpha worker");
    assert.equal(alpha.credentialCount, 3);
    assert.equal(alpha.activeCredentialCount, 2);
    assert.equal(alpha.internal, false);
    assert.equal(
      alpha.sources.some((s) => s.projectId === projects.other),
      false,
    );
    assert.equal(
      beta.sources.some((s) => s.projectReplicaId === "folder-beta"),
      false,
    );
    assert.equal(
      records.some((w) => w.workerId === "foreign"),
      false,
    );
    assert.equal(beta.internal, profile === "development");
    await settle("HEAD management catalog", "HEAD", "/api/workers/management");
    for (const [index, body] of [
      null,
      {},
      false,
      { name: null },
      { name: 4 },
      { name: "" },
      { name: " \u00a0" },
      { name: "a".repeat(121) },
    ].entries())
      await settle("invalid rename " + index, "PATCH", "/api/workers/alpha", {
        status: 400,
        json: body,
      });
    await settle(
      "binary rename remains a Buffer",
      "PATCH",
      "/api/workers/alpha",
      {
        status: 400,
        raw: '{"name":"not a JSON body"}',
        headers: { "content-type": "application/octet-stream" },
      },
    );
    await settle(
      "validation before missing worker",
      "PATCH",
      "/api/workers/missing",
      { status: 400, json: { name: "" } },
    );
    for (const id of ["missing", "foreign"]) {
      await settle(id + " rename", "PATCH", "/api/workers/" + id, {
        status: 404,
        json: { name: "Name" },
      });
      await settle(id + " restart", "POST", "/api/workers/" + id + "/restart", {
        status: 404,
      });
      await settle(id + " unlink", "DELETE", "/api/workers/" + id, {
        status: 404,
      });
    }
    await settle("offline restart", "POST", "/api/workers/beta/restart", {
      status: 409,
    });
    const renamed = await settle(
      "trimmed Unicode display name",
      "PATCH",
      "/api/workers/alpha",
      { json: { name: "\ufeff Studio 💫 \u00a0", unknown: "stripped" } },
      ["workers"],
    );
    assert.equal(renamed.name, "Studio 💫");
    const surrogate = await settle(
      "UTF-16 display name crosses PostgreSQL UTF-8 boundary",
      "PATCH",
      "/api/workers/alpha",
      { json: { name: "\ud800" } },
      ["workers"],
    );
    assert.equal(surrogate.name, "\ufffd");
    await settle(
      "embedded NUL rename preserves actual database rejection",
      "PATCH",
      "/api/workers/alpha",
      { json: { name: "prefix\u0000suffix" }, status: 500 },
    );
    await settle(
      "restore selected display name",
      "PATCH",
      "/api/workers/alpha",
      { json: { name: "Studio 💫" } },
      ["workers"],
    );
    const catalog = await management("runtime and display name separated");
    assert.equal(
      catalog.find((w) => w.workerId === "alpha").runtimeName,
      "alpha worker",
    );
    assert.equal(catalog.find((w) => w.workerId === "alpha").name, "Studio 💫");
    worker.report.name = "runtime renamed";
    await worker.pulse();
    const afterHeartbeat = await management("heartbeat preserves display name");
    assert.equal(
      afterHeartbeat.find((w) => w.workerId === "alpha").runtimeName,
      "runtime renamed",
    );
    assert.equal(
      afterHeartbeat.find((w) => w.workerId === "alpha").name,
      "Studio 💫",
    );
    const regular = await settle(
      "ordinary catalog uses display name",
      "GET",
      "/api/workers",
    );
    assert.equal(regular.find((w) => w.workerId === "alpha").name, "Studio 💫");
    await settle(
      "bootstrap rename rule",
      "PATCH",
      "/api/workers/beta",
      {
        status: profile === "development" ? 409 : 200,
        json: { name: "Beta display" },
      },
      profile === "development" ? [] : ["workers"],
    );
    await settle(
      "accepted worker restart",
      "POST",
      "/api/workers/alpha/restart",
      { status: 202, json: { ignored: true } },
    );
    for (const bad of [{}, { restarting: false }, null, 4]) {
      state.restartResult = bad === null ? { restarting: null } : bad;
      await settle(
        "malformed restart acknowledgment " + JSON.stringify(bad),
        "POST",
        "/api/workers/alpha/restart",
        { status: 500 },
      );
    }
    delete state.restartResult;
    state.failRestart = true;
    await settle(
      "worker restart error is uncaught",
      "POST",
      "/api/workers/alpha/restart",
      { status: 500 },
    );
    delete state.failRestart;
    if (values.deadlines && profile === "development") {
      const release = deferred();
      state.intercept = () => release.promise;
      const started = Date.now();
      try {
        await settle(
          "actual restart ten-second deadline",
          "POST",
          "/api/workers/alpha/restart",
          { status: 500, timeoutMs: 25000 },
        );
        result.restartDeadlineMs = Date.now() - started;
        assert.ok(
          result.restartDeadlineMs >= 9000 && result.restartDeadlineMs < 20000,
        );
      } finally {
        release.resolve();
        delete state.intercept;
      }
      await worker.pulse();
    }
    await f.sql([
      "UPDATE project_sources SET display_path='' WHERE id='folder-alpha'",
    ]);
    await settle(
      "invalid stored source fails GET catalog",
      "GET",
      "/api/workers/management",
      { status: 500 },
    );
    await settle(
      "rename does not validate unrelated stored source summaries",
      "PATCH",
      "/api/workers/alpha",
      { json: { name: "Final display" } },
      ["workers"],
    );
    await f.sql([
      "UPDATE project_sources SET display_path='/fixture/folder-alpha' WHERE id='folder-alpha'",
    ]);
    await f.sql([
      "CREATE FUNCTION management_fail_unlink() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled unlink write failure'; END $$",
      "CREATE TRIGGER management_fail_unlink BEFORE UPDATE OF unlinked_at ON workers FOR EACH ROW WHEN (NEW.id='alpha' AND NEW.unlinked_at IS NOT NULL) EXECUTE FUNCTION management_fail_unlink()",
    ]);
    try {
      await settle(
        "actual unlink transaction failure rolls back credentials",
        "DELETE",
        "/api/workers/alpha",
        { status: 500 },
      );
      assert.equal(worker.connected, true);
    } finally {
      await f.sql([
        "DROP TRIGGER management_fail_unlink ON workers",
        "DROP FUNCTION management_fail_unlink()",
      ]);
    }
    await live.ping("before unlink");
    live.frames = [];
    if (profile === "development")
      await settle(
        "internal unlink is protected",
        "DELETE",
        "/api/workers/beta",
        { status: 409 },
      );
    else
      await settle(
        "uncredentialed standalone worker can unlink",
        "DELETE",
        "/api/workers/beta",
        { status: 204 },
        ["workers"],
      );
    const entered = deferred(),
      release = deferred();
    state.intercept = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = visit(
      "pending restart rejected by unlink",
      "POST",
      "/api/workers/alpha/restart",
      { status: 409 },
    );
    try {
      await entered.promise;
      const before = await snapshot();
      const outcomes = await Promise.all(
        Array.from({ length: 4 }, async (_, index) => {
          const response = await fetch(f.server.origin + "/api/workers/alpha", {
            method: "DELETE",
            headers: {
              origin: "http://127.0.0.1:5173",
              cookie: [...f.client().cookies]
                .map(([k, v]) => k + "=" + v)
                .join("; "),
              ...(f.client().csrf ? { "x-cantrip-csrf": f.client().csrf } : {}),
            },
            signal: AbortSignal.timeout(15000),
          });
          const text = await response.text();
          return {
            status: response.status,
            body: text ? JSON.parse(text) : null,
          };
        }),
      );
      assert.deepEqual(
        outcomes.map((v) => v.status).sort(),
        [204, 404, 404, 404],
      );
      result.concurrentUnlink = outcomes.sort((a, b) => a.status - b.status);
      await pending;
      await eventually(
        () => worker.connected,
        (v) => assert.equal(v, false),
      );
      const after = await snapshot();
      for (const table of ["projects", "sources", "settings", "codes"])
        assert.deepEqual(
          after[table],
          before[table],
          "Unlink preserves existing " + table,
        );
      const row = after.workers.find((w) => w.id === "alpha");
      assert.ok(row.unlinked_at);
      assert.equal(row.display_name, "Final display");
      for (const credential of after.credentials.filter(
        (c) => c.worker_id === "alpha",
      )) {
        const previous = before.credentials.find((c) => c.id === credential.id);
        if (previous.revoked_at) assert.deepEqual(credential, previous);
        else {
          assert.ok(credential.revoked_at);
          assert.equal(credential.revoked_reason, "worker unlinked by owner");
        }
      }
      result.unlinkSQL = {
        before: comparableSQL(before, f),
        after: comparableSQL(after, f),
      };
      await writeFile(
        path.join(evidence, "concurrent-unlink.json"),
        JSON.stringify({ before, after, outcomes }, null, 2) + "\n",
      );
      await live.ping("after unlink");
      result.unlinkLive = live.frames
        .filter((frame) => frame.type === "event")
        .map(({ cursor, ...event }) => f.normalize(event));
      assert.ok(
        result.unlinkLive.some(
          (e) =>
            e.event?.resource === "worker-availability" ||
            e.resource === "worker-availability",
        ),
      );
    } finally {
      release.resolve();
      delete state.intercept;
    }
    await settle(
      "unlinked worker disappears",
      "GET",
      "/api/workers/management",
    );
    await settle(
      "old credential cannot heartbeat",
      "POST",
      "/api/internal/workers/heartbeat",
      {
        client: "worker",
        status: 401,
        json: worker.report,
        headers: { authorization: "Bearer " + worker.config.token },
      },
    );
    await managementReopen({
      f,
      profile,
      state,
      worker,
      live,
      root: path.join(root, profile, f.kind),
      snapshot,
      visit,
      settle,
      management,
      result,
      replace(value) {
        worker = value.worker;
        live = value.live;
      },
    });
    result.passed = true;
  } finally {
    result.diagnostics = f.server?.diagnostics();
    worker?.close();
    if (live) {
      result.liveHistory = live.history;
      await live.close();
    }
    await f.close();
  }
}
let pg;
try {
  const built =
      process.env.CANTRIP_RUST_SERVER_BINARY ??
      (await buildRustExample("http-sql-fixture")),
    executable = path.join(
      root,
      "server-fixture" + (process.platform === "win32" ? ".exe" : ""),
    );
  await copyFile(built, executable);
  report.executable = executable;
  report.executableSha256 = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex");
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  const passwordHash = await hashPassword(password);
  for (const profile of values.profile
    ? [values.profile]
    : ["development", "password", "accounts", "standalone"]) {
    const cell = { profile, runtimes: [] };
    report.profiles.push(cell);
    for (const kind of ["node", "rust"]) {
      process.stderr.write(
        JSON.stringify({
          event: "worker-management.http.started",
          database: values.database,
          profile,
          kind,
        }) + "\n",
      );
      const url =
        pg && (kind === "node" || values.database === "postgres")
          ? await pg.database()
          : undefined;
      const environment = {
        CANTRIP_AUTH_MODE: ["development", "standalone"].includes(profile)
          ? "none"
          : profile,
        PGLITE_RUNTIME_DIR: path.join(root, profile, kind, "pglite-runtime"),
        CANTRIP_FIXTURE_LOGGING: "true",
        CANTRIP_REGISTRATION_ENABLED: "true",
        ...(profile === "password"
          ? { CANTRIP_PASSWORD_HASH: passwordHash }
          : {}),
        ...(url ? { DATABASE_URL: url } : {}),
        ...(profile === "standalone"
          ? { CANTRIP_BOOTSTRAP_MODE: "standalone" }
          : {}),
        ...(kind === "rust" && values.database === "bundled-postgres"
          ? {
              CANTRIP_POSTGRES_BIN_DIR:
                process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
            }
          : {}),
      };
      const f = new HttpFixture({
        kind,
        executable,
        root,
        name: profile,
        databaseMode: values.database,
        liveSqlFixture: true,
        environment,
      });
      if (profile === "standalone") delete f.environment.CANTRIP_WORKER_TOKEN;
      const result = { kind, http: [], cases: [] };
      cell.runtimes.push(result);
      await run(f, profile, result);
    }
    const [left, right] = cell.runtimes;
    assert.deepEqual(
      right.http,
      left.http,
      profile + " complete HTTP contracts",
    );
    const comparable = (r) =>
      r.cases.map(({ rawStatePath, ...value }) => value);
    assert.deepEqual(
      comparable(right),
      comparable(left),
      profile + " complete SQL and worker operations",
    );
    assert.deepEqual(right.concurrentUnlink, left.concurrentUnlink);
    assert.deepEqual(right.unlinkSQL, left.unlinkSQL);
    assert.deepEqual(
      right.unlinkLive,
      left.unlinkLive,
      profile + " unlink App Live publication",
    );
  }
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  try {
    await pg?.close();
  } catch (error) {
    report.passed = false;
    report.postgresShutdownFailure = error.stack;
    throw error;
  } finally {
    if (values.report) {
      await mkdir(path.dirname(path.resolve(values.report)), {
        recursive: true,
      });
      await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
    }
  }
}
console.log(
  JSON.stringify({
    root,
    passed: report.passed,
    profiles: report.profiles.length,
  }),
);
