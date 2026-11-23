// Same real HTTP/SQL/Live scenarios through Source and the native server.
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
import { performance } from "node:perf_hooks";
import { buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { managementWorker } from "./worker-management-http-worker.mjs";
import {
  workerOperationLifecycle,
  longFetch,
} from "./worker-operation-http-lifecycle.mjs";
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
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { unavailableManagedWebRuntimeCapabilities as runtimes } from "../../packages/protocol/dist/index.js";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    profile: { type: "string" },
    kind: { type: "string" },
    report: { type: "string" },
    "long-deadline": { type: "boolean", default: false },
    lifecycle: { type: "boolean", default: false },
  },
});
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-worker-operation-http-"),
);
process.stderr.write(
  JSON.stringify({ event: "worker-operation.http.created", root }) + "\n",
);
const report = {
  root,
  database: values.database,
  profiles: [],
  completeReplacement: false,
  scope:
    "Production HTTP/SQL/Live and unchanged WorkerConnection; endpoint CodeGraph/web runtime effects are controlled. Full worker/assets and platform acceptance remain required.",
};
const project = "11111111-1111-4111-8111-000000000001";
const projects = {
  github: project,
  folder: "11111111-1111-4111-8111-000000000002",
  "local-git": "11111111-1111-4111-8111-000000000003",
  other: "11111111-1111-4111-8111-000000000004",
};
const prefix = `/api/projects/${project}/worktrees/github-alpha-main/codegraph`;
const types = [
  "worker.version",
  "codegraph.update.check",
  "codegraph.status",
  "codegraph.sync",
  "codegraph.rebuild",
  "web-runtime.action",
];
const schemaSnapshot =
  "SELECT jsonb_build_object('workers',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM workers w),'credentials',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM worker_credentials w),'codes',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM worker_enrollment_codes w),'projects',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM projects w),'sources',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM project_sources w),'worktrees',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM project_worktrees w),'settings',(SELECT jsonb_agg(to_jsonb(w) ORDER BY user_id) FROM user_settings w))::text AS result";
const gate = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function normalizeSQL(raw, f) {
  const hashes = new Map(
    [...f.workerCredentials, ...f.workerCodes].map(([value, label]) => [
      createHash("sha256").update(value).digest("hex"),
      `<sha256:${label}>`,
    ]),
  );
  const walk = (v, key = "") => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, walk(x, k)]),
      );
    if (typeof v !== "string") return v;
    if (["secret_hash", "code_hash"].includes(key)) {
      assert.ok(
        hashes.has(v),
        "Stored hash belongs to an actually issued credential/code",
      );
      return hashes.get(v);
    }
    if (/_at$/.test(key)) {
      assert.ok(Number.isFinite(Date.parse(v)), key);
      const iso = new Date(v).toISOString();
      if (iso === stamp) return stamp;
      if (key === "expires_at" && f.enrollmentExpirations.has(iso))
        return "<enrollment-code-expiry>";
      assert.ok(Date.parse(v) <= Date.now() + 1000, key);
      return "<database-timestamp>";
    }
    return f.normalize(v, key);
  };
  const value = walk(raw);
  for (const rows of Object.values(value))
    if (Array.isArray(rows))
      rows.sort((a, b) =>
        String(a.id ?? a.user_id).localeCompare(String(b.id ?? b.user_id)),
      );
  return value;
}
function response(command) {
  if (command.type === "worker.version")
    return { major: 1, minor: 2, patch: 3, version: "1.2.3", unknown: true };
  if (command.type === "codegraph.status")
    return {
      projectId: command.projectId,
      worktreeId: command.worktreeId,
      state: "ready",
      lastIndexedAt: stamp,
      lastSuccessfulSyncAt: stamp,
      fileCount: 31,
      nodeCount: 47,
      edgeCount: 89,
      pendingChanges: 0,
      statusMessage: null,
      job: null,
    };
  if (command.type === "web-runtime.action")
    return {
      accepted: true,
      action: command.action,
      component: command.component,
      status:
        command.component === "searxng" ? runtimes.search : runtimes.browser,
    };
  return {
    jobId: "88888888-8888-4888-8888-000000000001",
    action:
      command.type === "codegraph.update.check"
        ? "update-check"
        : command.type.split(".").at(-1),
    acceptedAt: stamp,
    status: "queued",
    unknown: true,
  };
}
async function run(f, profile, result) {
  const state = { commands: [], background: [], disconnects: 0, completed: 0 };
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
  const snapshot = async () => (await f.sql([], [schemaSnapshot]))[0];
  const settle = async (name, method, url, options = {}) => {
    await live.ping(name + " before");
    const offset = state.commands.length,
      eventOffset = live.frames.length,
      before = await snapshot();
    const value = await visit(name, method, url, options),
      after = await snapshot();
    assert.deepEqual(
      after,
      before,
      name + " preserves all seven stored domains",
    );
    await live.ping(name + " after");
    const events = live.frames
      .slice(eventOffset)
      .filter(
        (frame) =>
          frame.type === "event" &&
          ["worker", "worktree"].includes(frame.resource),
      )
      .map(({ cursor, ...event }) => f.normalize(event));
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
      before: normalizeSQL(before, f),
      after: normalizeSQL(after, f),
      rawStatePath,
    });
    return value;
  };
  try {
    await f.start();
    const auth =
      profile === "accounts"
        ? await visit("register", "POST", "/api/auth/register", {
            status: 201,
            json: {
              email: "operations@example.invalid",
              displayName: "Operations",
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
      types.map((type) => [
        type,
        async (command) => {
          state.commands.push(command);
          if (state.intercept) await state.intercept(command);
          state.completed += 1;
          if (state.error) throw new Error(state.error);
          return Object.hasOwn(state, "reply")
            ? state.reply
            : response(command);
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
    await f.sql([
      ...targetStateSql(owner, otherOwner, projects).filter(
        (sql) => !/^INSERT INTO workers.*VALUES\('alpha'/.test(sql),
      ),
      `UPDATE workers SET remote_surface_capabilities=${json(heartbeat.remoteSurfaces)} WHERE id<>'alpha'`,
      `UPDATE workers SET last_seen_at=${literal(stamp)} WHERE id<>'alpha'`,
    ]);
    live = new LiveProbe(f);
    await live.opened;
    await live.initialized();
    await live.subscribed("worker operations", [
      { kind: "current-user" },
      { kind: "project", projectId: project },
      { kind: "project", projectId: projects.folder },
    ]);
    const actions = [
      ["version", "GET", "/api/workers/alpha/version", {}],
      [
        "update check",
        "POST",
        "/api/workers/alpha/codegraph/update-check",
        { status: 202 },
      ],
      [
        "web action",
        "POST",
        "/api/workers/alpha/web-runtimes/actions",
        { json: { component: "playwright", action: "retry" } },
      ],
      ["status", "GET", prefix, {}],
      ["sync", "POST", prefix + "/sync", { status: 202 }],
      ["rebuild", "POST", prefix + "/rebuild", { status: 202 }],
    ];
    for (const [name, method, url, options] of actions)
      await settle(name, method, url, options);
    await settle("version HEAD", "HEAD", actions[0][2]);
    await settle("status HEAD", "HEAD", prefix);
    await settle("worker action ignores supplied body", "POST", actions[1][2], {
      status: 202,
      json: { workerId: "foreign", type: "ignored", access: "read" },
    });
    await settle(
      "worktree action ignores supplied body",
      "POST",
      prefix + "/sync",
      {
        status: 202,
        json: {
          projectId: projects.other,
          worktreeId: "foreign",
          access: "read",
        },
      },
    );
    await f.sql([
      "UPDATE project_worktrees SET name='',display_path='' WHERE id='github-alpha-main'",
    ]);
    await settle(
      "unused worktree display metadata is not revalidated",
      "GET",
      prefix,
    );
    await f.sql([
      "UPDATE project_worktrees SET name='main',display_path='/fixture/github-alpha',lifecycle_state='missing' WHERE id='github-alpha-main'",
    ]);
    await settle(
      "non-ready worktree cannot dispatch",
      "POST",
      prefix + "/rebuild",
      { status: 404 },
    );
    await f.sql([
      "UPDATE project_worktrees SET lifecycle_state='ready' WHERE id='github-alpha-main'",
    ]);
    const opaqueSource = "ctrr_" + Buffer.alloc(32, 1).toString("base64url"),
      opaqueTree = "ctrr_" + Buffer.alloc(32, 2).toString("base64url");
    await f.sql([
      `UPDATE project_sources SET absolute_path=${literal(opaqueSource)} WHERE id='folder-alpha'`,
      `UPDATE project_worktrees SET root_kind='folder-root',is_default=true,absolute_path=${literal(opaqueTree)} WHERE id='folder-alpha-main'`,
    ]);
    const folder = `/api/projects/${projects.folder}/worktrees/folder-alpha-main/codegraph`;
    await settle("folder capability rejects status", "GET", folder, {
      status: 409,
    });
    await settle("folder capability rejects sync", "POST", folder + "/sync", {
      status: 409,
    });
    await settle(
      "folder capability rejects rebuild",
      "POST",
      folder + "/rebuild",
      {
        status: 409,
      },
    );
    await settle(
      "folder capability precedes missing worktree",
      "POST",
      folder.replace("folder-alpha-main", "missing") + "/sync",
      { status: 409 },
    );
    const opaqueGitSource = "ctrr_" + Buffer.alloc(32, 3).toString("base64url"),
      opaqueGitTree = "ctrr_" + Buffer.alloc(32, 4).toString("base64url");
    await f.sql([
      `UPDATE project_sources SET absolute_path=${literal(opaqueGitSource)} WHERE id='github-alpha'`,
      `UPDATE project_worktrees SET absolute_path=${literal(opaqueGitTree)} WHERE id='github-alpha-main'`,
    ]);
    await settle("opaque Git source status", "GET", prefix);
    await settle("opaque Git source sync", "POST", prefix + "/sync", {
      status: 202,
    });
    await settle("opaque Git source rebuild", "POST", prefix + "/rebuild", {
      status: 202,
    });
    for (const id of ["missing", "foreign"])
      for (const [name, method, url, options] of actions.slice(0, 3))
        await settle(
          `${id} ${name}`,
          method,
          url.replace("/alpha/", `/${id}/`),
          { ...options, status: 404 },
        );
    for (const [name, method, url, options] of actions.slice(3)) {
      await settle(
        "foreign project " + name,
        method,
        url.replace(project, projects.other),
        { ...options, status: 404 },
      );
      await settle(
        "missing worktree " + name,
        method,
        url.replace("github-alpha-main", "missing"),
        { ...options, status: 404 },
      );
    }
    await f.sql([
      `UPDATE project_sources SET removed_at=${literal(stamp)} WHERE id='github-alpha'`,
    ]);
    await settle("removed source cannot dispatch", "POST", prefix + "/sync", {
      status: 404,
    });
    await f.sql([
      "UPDATE project_sources SET removed_at=NULL WHERE id='github-alpha'",
    ]);
    for (const [name, method, url, options] of actions) {
      const offline = url.startsWith("/api/workers/")
        ? url.replace("/alpha/", "/beta/")
        : url.replace("github-alpha-main", "github-beta-main");
      await settle("offline " + name, method, offline, {
        ...options,
        status: 503,
      });
    }
    for (const input of [
      null,
      {},
      { component: "searxng", action: "clear-profiles" },
      { component: "playwright", action: "retry", unknown: true },
      { component: "playwright", action: "unknown" },
    ])
      await settle(
        "invalid web " + JSON.stringify(input),
        "POST",
        actions[2][2],
        { status: 400, json: input },
      );
    await settle(
      "validation precedes missing worker",
      "POST",
      actions[2][2].replace("/alpha/", "/missing/"),
      { status: 400, json: {} },
    );
    await settle("web malformed JSON", "POST", actions[2][2], {
      status: 400,
      raw: "{",
      headers: { "content-type": "application/json" },
    });
    await settle("web Buffer body", "POST", actions[2][2], {
      status: 400,
      raw: Buffer.from([1, 2]),
      headers: { "content-type": "application/octet-stream" },
    });
    for (const [name, method, url, options] of actions) {
      state.reply = {};
      await settle("malformed response " + name, method, url, {
        ...options,
        status: 502,
      });
      delete state.reply;
      state.error = "Controlled endpoint operation failed";
      await settle("worker failure " + name, method, url, {
        ...options,
        status: 502,
      });
      delete state.error;
    }
    for (const reply of [
      { major: 1, minor: 2, patch: 3, version: "9.9.9" },
      { major: 0, minor: 0, patch: 0, version: "0.0.0" },
    ]) {
      state.reply = reply;
      await settle(
        "version refinement " + reply.version,
        "GET",
        actions[0][2],
        { status: reply.version === "9.9.9" ? 502 : 200 },
      );
    }
    delete state.reply;
    state.reply = {
      ...response({
        type: "web-runtime.action",
        component: "playwright",
        action: "retry",
      }),
      component: "searxng",
    };
    await settle(
      "independent runtime response fields",
      "POST",
      actions[2][2],
      actions[2][3],
    );
    delete state.reply;
    if (profile === "development") {
      const release = gate();
      state.intercept = () => release.promise;
      const started = performance.now();
      try {
        const body = await settle(
          "real five second deadline",
          "POST",
          actions[1][2],
          { status: 502 },
        );
        const elapsed = performance.now() - started;
        assert.ok(elapsed >= 5000 && elapsed < 15000, String(elapsed));
        assert.equal(
          body.error,
          "Worker command codegraph.update.check timed out.",
        );
        result.shortDeadlineMs = elapsed;
      } finally {
        release.resolve();
        delete state.intercept;
      }
      await settle("after late response", "GET", actions[0][2]);
    }
    if (values["long-deadline"]) {
      assert.equal(profile, "development");
      const release = gate(),
        before = state.completed;
      state.intercept = () => release.promise;
      const started = performance.now();
      let heartbeatPending = false;
      let heartbeatSequence = 0;
      const pulse = setInterval(() => {
        if (heartbeatPending) return;
        heartbeatPending = true;
        live
          .ping("long deadline heartbeat " + heartbeatSequence++)
          .catch((error) => {
            result.longHeartbeatFailure = error.stack;
          })
          .finally(() => {
            heartbeatPending = false;
          });
      }, 15000);
      process.stderr.write(
        JSON.stringify({
          event: "worker-operation.long-deadline.started",
          kind: f.kind,
          root,
        }) + "\n",
      );
      try {
        const body = await settle(
          "real twelve minute deadline",
          "POST",
          actions[2][2],
          {
            ...actions[2][3],
            status: 502,
            timeoutMs: 735000,
            fetcher: async (...args) => {
              const response = await longFetch(...args);
              result.longDeadlineResponseMs = performance.now() - started;
              return response;
            },
          },
        );
        result.longDeadlineMs = performance.now() - started;
        assert.equal(result.longHeartbeatFailure, undefined);
        assert.ok(
          result.longDeadlineMs >= 720000 && result.longDeadlineMs < 735000,
          String(result.longDeadlineMs),
        );
        assert.equal(
          body.error,
          "Worker command web-runtime.action timed out.",
        );
      } finally {
        clearInterval(pulse);
        release.resolve();
        delete state.intercept;
      }
      await eventually(
        () => state.completed,
        (count) => assert.equal(count, before + 1),
      );
      await settle("after late twelve minute response", "GET", actions[0][2]);
    }
    if (values.lifecycle && profile === "development") {
      await workerOperationLifecycle({
        f,
        worker,
        live,
        state,
        snapshot,
        settle,
        visit,
        actions,
        result,
        evidence,
        normalize: normalizeSQL,
        project,
        replaceLive(value) {
          live = value;
        },
      });
    }
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
  let executable;
  if (values.kind !== "node") {
    const built =
      process.env.CANTRIP_RUST_SERVER_BINARY ??
      (await buildRustExample("http-sql-fixture"));
    executable = path.join(
      root,
      "server-fixture" + (process.platform === "win32" ? ".exe" : ""),
    );
    await copyFile(built, executable);
    report.executable = executable;
    report.executableSha256 = createHash("sha256")
      .update(await readFile(executable))
      .digest("hex");
  }
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  const passwordHash = await hashPassword(password);
  for (const profile of values.profile
    ? [values.profile]
    : ["development", "password", "accounts", "standalone"]) {
    const cell = { profile, runtimes: [] };
    report.profiles.push(cell);
    for (const kind of values.kind ? [values.kind] : ["node", "rust"]) {
      process.stderr.write(
        JSON.stringify({
          event: "worker-operation.http.started",
          database: values.database,
          profile,
          kind,
        }) + "\n",
      );
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
          CANTRIP_AUTH_MODE: ["development", "standalone"].includes(profile)
            ? "none"
            : profile,
          CANTRIP_REGISTRATION_ENABLED: "true",
          CANTRIP_FIXTURE_LOGGING: "true",
          PGLITE_RUNTIME_DIR: path.join(root, profile, kind, "pglite-runtime"),
          ...(profile === "password"
            ? { CANTRIP_PASSWORD_HASH: passwordHash }
            : {}),
          ...(profile === "standalone"
            ? { CANTRIP_BOOTSTRAP_MODE: "standalone" }
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
      if (profile === "standalone") delete f.environment.CANTRIP_WORKER_TOKEN;
      const result = { kind, http: [], cases: [] };
      cell.runtimes.push(result);
      await run(f, profile, result);
    }
    if (cell.runtimes.length === 2) {
      const [left, right] = cell.runtimes;
      assert.deepEqual(
        right.http,
        left.http,
        profile + " complete HTTP contracts",
      );
      const comparable = (result) =>
        result.cases.map(({ rawStatePath, ...entry }) => entry);
      assert.deepEqual(
        comparable(right),
        comparable(left),
        profile + " complete SQL/worker/Live behavior",
      );
      assert.deepEqual(
        right.lifecycle,
        left.lifecycle,
        profile + " caller loss and retained state",
      );
    }
  }
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  try {
    await pg?.close();
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
