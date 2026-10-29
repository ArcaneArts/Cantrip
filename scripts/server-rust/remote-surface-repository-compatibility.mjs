// Actual owner/canonical-state reads and durable remote-surface status writes.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import {
  targetStateSql,
  localOwner as owner,
  otherOwner as other,
  literal,
  json,
  label,
  state,
  stamp,
} from "./project-target-state.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report"),
  started = Date.now();
const root = await mkdtemp(path.join(tmpdir(), "cantrip-surface-repository-")),
  report = {
    suite: "remote-surface-repository",
    databaseMode,
    completeReplacement: false,
    cases: [],
    snapshots: [],
  },
  pair = [],
  urls = [];
let executable, pg, failure;
const open = (kind, i) =>
  repositoryFixture({
    kind,
    executable,
    root,
    databaseMode,
    databaseUrl: urls[i],
  });
const seed = async (sql) => {
  for (const repo of pair) await repo.seed(sql);
};
function normalize(value, key = "") {
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalize(v, k)]),
    );
  if (
    typeof value === "string" &&
    [
      "createdAt",
      "updatedAt",
      "lastConnectedAt",
      "created_at",
      "updated_at",
      "last_connected_at",
    ].includes(key)
  ) {
    const at = Date.parse(value);
    assert.ok(Number.isFinite(at));
    if (at === Date.parse(stamp)) return "<fixture-time>";
    assert.ok(at >= started - 1000 && at <= Date.now() + 1000);
    return "<write-time>";
  }
  return value;
}
async function compare(
  label,
  operation,
  { rejected = false, diagnostic = true } = {},
) {
  const request = { owner, surface: "remote", ...operation },
    values = await Promise.all(pair.map((r) => r.request(request)));
  report.cases.push({ label, request, values });
  assert.equal(
    values[0].rejected,
    rejected,
    "Actual reference outcome " + label,
  );
  const observable = (v) =>
    v.rejected
      ? { rejected: true, ...(diagnostic ? { diagnostic: v.diagnostic } : {}) }
      : { rejected: false, value: normalize(v.value) };
  assert.deepEqual(observable(values[1]), observable(values[0]), label);
  return values[0].value;
}
const context = (label, surface = "remote", principal = owner, options) =>
  compare(label, { op: "surface-context", surface, owner: principal }, options);
async function snapshot(label) {
  const raw = await Promise.all(
    pair.map((r) =>
      r.request({
        op: "query-json",
        sql: "SELECT jsonb_agg(to_jsonb(r) ORDER BY id) result FROM remote_surfaces r",
      }),
    ),
  );
  raw.forEach((r) => assert.equal(r.rejected, false));
  report.snapshots.push({ label, raw });
  assert.deepEqual(normalize(raw[1].value), normalize(raw[0].value), label);
  return raw[0].value;
}
try {
  executable = await buildRustExample("project-repository-fixture");
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const [i, kind] of ["node", "rust"].entries()) {
    if (pg && (kind === "node" || databaseMode === "postgres"))
      urls[i] = await pg.database();
    pair.push(await open(kind, i));
  }
  for (const sql of targetStateSql()) await seed(sql);
  for (const surface of [
    "browser",
    "desktop",
    "remote",
    "raw-browser",
    "missing",
    "other-browser",
    "other-desktop",
    "other-remote",
  ])
    await context("canonical execution context " + surface, surface);
  for (const surface of ["browser", "desktop", "remote", "raw-browser"])
    assert.equal(
      await context("foreign execution context " + surface, surface, other),
      null,
    );
  for (const [id, project, worker] of [
    ["owned-worker-foreign-project", "other", "alpha"],
    ["foreign-worker-owned-project", "github", "foreign"],
  ]) {
    await seed(
      `INSERT INTO remote_surfaces(id,project_id,worker_id,kind,configuration,protected_label,protected_state,state_revision,created_at,updated_at) VALUES(${literal(id)},${literal(project)},${literal(worker)},'browser','{"kind":"browser","profileId":null}',${json(label("remote-surface"))},${json(state("browser-state"))},1,${literal(stamp)},${literal(stamp)});`,
    );
    for (const principal of [owner, other])
      assert.equal(
        await context(
          "both project and worker must belong to owner " + id,
          id,
          principal,
        ),
        null,
      );
  }
  await seed(
    `UPDATE project_sources SET removed_at=${literal(stamp)} WHERE project_id='github'`,
  );
  assert.ok(
    await context("removed source metadata does not add a context filter"),
  );
  await seed(
    "UPDATE project_sources SET removed_at=NULL WHERE project_id='github'",
  );
  await seed(
    `UPDATE workers SET remote_surface_capabilities='{"browser":false,"desktop":false}' WHERE id='alpha'`,
  );
  assert.deepEqual(
    (
      await context(
        "capability metadata is retained without a speculative gate",
      )
    ).remoteSurfaceCapabilities,
    { browser: false, desktop: false },
  );
  await seed(
    `UPDATE workers SET remote_surface_capabilities='{"browser":true,"desktop":true}' WHERE id='alpha'`,
  );
  await seed(
    "UPDATE remote_surfaces SET protected_label=NULL,protected_state=NULL,state_revision=NULL WHERE id='browser'",
  );
  await seed(
    "UPDATE remote_surfaces SET protected_label=NULL WHERE id='desktop'",
  );
  await context(
    "browser canonical private state wins over legacy nulls",
    "browser",
  );
  await seed(
    `UPDATE remote_surfaces SET protected_state=${json(state("remote-desktop-state"))},state_revision=1 WHERE id='desktop'`,
  );
  await context("desktop canonical view label fallback", "desktop");
  await seed("UPDATE remote_surfaces SET state_revision=0 WHERE id='remote'");
  await context("zero revision preserves mapper error", "remote", owner, {
    rejected: true,
  });
  await seed("UPDATE remote_surfaces SET state_revision=1 WHERE id='remote'");
  for (const [status, error] of [
    ["connecting", null],
    ["active", null],
    ["offline", "Worker is offline."],
    ["error", "Controlled surface failure"],
    ["idle", null],
    ["active", "diagnostic with \ud800"],
  ]) {
    const previous = await snapshot("before " + status);
    await compare("persist status " + status, {
      op: "surface-status",
      status,
      error,
    });
    const current = await snapshot("after " + status),
      surface = current.find((r) => r.id === "remote");
    assert.equal(surface.status, status);
    assert.equal(surface.last_error, error?.replace("\ud800", "�") ?? null);
    if (status !== "active")
      assert.equal(
        surface.last_connected_at,
        previous.find((r) => r.id === "remote").last_connected_at,
      );
    await context("projection after " + status);
  }
  await compare("repository preserves permissive stored status strings", {
    op: "surface-status",
    status: "invalid",
  });
  await snapshot("unrecognized status is stored without invented validation");
  await seed(
    "ALTER TABLE remote_surfaces ADD CONSTRAINT fixture_status_failure CHECK(status <> 'fixture-rejected')",
  );
  const before = await snapshot("before failed write");
  await compare(
    "actual database constraint rejects status write",
    { op: "surface-status", status: "fixture-rejected" },
    { rejected: true, diagnostic: false },
  );
  assert.deepEqual(
    await snapshot("failed status write leaves all rows unchanged"),
    before,
  );
  await seed(
    "ALTER TABLE remote_surfaces DROP CONSTRAINT fixture_status_failure",
  );
  await compare("offline state for reset", {
    op: "surface-status",
    status: "offline",
    error: "temporary offline",
  });
  await compare("missing status target is a completed zero-row update", {
    op: "surface-status",
    surface: "missing",
    status: "active",
  });
  await compare("connecting state for reset", {
    op: "surface-status",
    surface: "browser",
    status: "connecting",
  });
  await compare("error state for reset", {
    op: "surface-status",
    surface: "raw-browser",
    status: "error",
    error: "retained failure",
  });
  await compare("reset actual transient statuses", { op: "surface-reset" });
  let rows = await snapshot(
    "reset preserves terminal errors and clears transient errors",
  );
  assert.equal(rows.find((r) => r.id === "browser").status, "idle");
  assert.equal(rows.find((r) => r.id === "remote").status, "idle");
  assert.equal(rows.find((r) => r.id === "remote").last_error, null);
  assert.equal(rows.find((r) => r.id === "raw-browser").status, "error");
  assert.equal(
    rows.find((r) => r.id === "raw-browser").last_error,
    "retained failure",
  );
  await seed("DELETE FROM remote_surfaces WHERE id='browser'");
  await compare("browser bootstrap only selects the requested owner", {
    op: "surface-ensure-browsers",
    owner: other,
  });
  assert.equal(
    await context("foreign bootstrap does not create owned browser", "browser"),
    null,
  );
  await seed(
    `UPDATE project_sources SET removed_at=${literal(stamp)} WHERE project_id='github'`,
  );
  await compare("browser bootstrap skips absent usable source", {
    op: "surface-ensure-browsers",
  });
  assert.equal(
    await context("removed sources cannot bootstrap browser", "browser"),
    null,
  );
  await seed(
    "UPDATE project_sources SET removed_at=NULL WHERE project_id='github'",
  );
  await compare("browser bootstrap prefers configured project worker", {
    op: "surface-ensure-browsers",
  });
  assert.equal(
    (await context("backfilled browser is usable", "browser")).workerId,
    "alpha",
  );
  rows = await snapshot(
    "backfill preserves opaque canonical browser state and source defaults",
  );
  let browser = rows.find((r) => r.id === "browser");
  assert.equal(browser.preferred_transport, "webrtc");
  assert.equal(browser.protected_label, null);
  assert.equal(browser.protected_state, null);
  assert.deepEqual(browser.configuration, { kind: "browser", profileId: null });
  await seed(
    "UPDATE projects SET preferred_worker_id='beta' WHERE id='github'",
  );
  await compare("browser bootstrap leaves existing placement untouched", {
    op: "surface-ensure-browsers",
  });
  assert.equal(
    (await context("existing browser stays on alpha", "browser")).workerId,
    "alpha",
  );
  await seed("DELETE FROM remote_surfaces WHERE id='browser'");
  await seed("UPDATE projects SET preferred_worker_id=NULL WHERE id='github'");
  await compare("browser bootstrap falls back to configured default worker", {
    op: "surface-ensure-browsers",
  });
  assert.equal(
    (await context("default worker backfill", "browser")).workerId,
    "beta",
  );
  await seed("DELETE FROM remote_surfaces WHERE id='browser'");
  await seed(
    "UPDATE project_worktrees SET lifecycle_state='preparing' WHERE project_source_id='github-beta'",
  );
  await compare(
    "browser bootstrap ignores unavailable lifecycle but not online status",
    { op: "surface-ensure-browsers" },
  );
  assert.equal(
    (await context("only ready source is used", "browser")).workerId,
    "alpha",
  );
  const retained = await snapshot("retained surface state");
  for (let i = 0; i < pair.length; i++) {
    await pair[i].close();
    pair[i] = await open(i === 0 ? "node" : "rust", i);
  }
  assert.deepEqual(
    await snapshot("reopen retains canonical surface and status state"),
    retained,
  );
} catch (error) {
  failure = error;
  report.error = { message: error.message, stack: error.stack };
} finally {
  const outcomes = await Promise.allSettled(pair.map((r) => r.close()));
  const errors = outcomes
    .filter((r) => r.status === "rejected")
    .map((r) => r.reason);
  try {
    await pg?.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      "Surface repository scenario/cleanup failed",
    );
  await rm(root, { recursive: true, force: true });
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    cases: report.cases.length,
    snapshots: report.snapshots.length,
    error: report.error?.message,
  }),
);
if (failure) throw failure;
