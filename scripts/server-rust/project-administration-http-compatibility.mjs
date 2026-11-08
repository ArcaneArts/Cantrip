// Real production routers, SQL, App Live and production WorkerConnection.
// Only worker cleanup effects and disposable SQL setup are controlled here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { managementWorker } from "./worker-management-http-worker.mjs";
import { eventually, auditRows } from "./audit-observations.mjs";
import { password } from "./security-fixtures.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import {
  projects,
  seed,
  snapshotQuery,
  comparable,
  literal,
  localOwner,
} from "./project-administration-state.mjs";
import {
  preferenceCases,
  removalCases,
} from "./project-administration-http-cases.mjs";
import { administrationBoundaries } from "./project-administration-boundaries.mjs";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    profile: { type: "string" },
    runtime: { type: "string" },
    report: { type: "string" },
    boundaries: { type: "boolean", default: false },
  },
});
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(values.database));
assert.ok(!values.runtime || ["node", "rust"].includes(values.runtime));
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-project-administration-http-"),
);
console.error(
  JSON.stringify({ event: "project-administration.created", root }),
);
const report = {
  root,
  database: values.database,
  profiles: [],
  completeReplacement: false,
  scope:
    "Project lifecycle/preferences through actual HTTP/SQL/Live and production WorkerConnection. Controlled cleanup effects; full-worker/platform acceptance is separate.",
};

async function run(f, profile, result) {
  const state = { commands: [], authority: [], background: [], disconnects: 0 };
  let worker, live, log;
  const visit = async (name, method, url, options = {}) => {
    result.http.push({
      name,
      ...(await f.observe(name, method, url, { csrf: true, ...options })),
    });
    return f.records.get(name);
  };
  const snapshot = async () => (await f.sql([], [snapshotQuery]))[0];
  const settle = async (name, method, url, options = {}, mutation) => {
    console.error(
      JSON.stringify({
        event: "project-administration.case",
        profile,
        kind: f.kind,
        name,
      }),
    );
    await live.ping(name + " before");
    const before = await snapshot();
    const id = decodeURIComponent(url.split("/")[3]);
    await live.subscribed(name + " scopes", [
      { kind: "current-user" },
      ...(before.projects.some((p) => p.id === id && p.owner_id === f.owner)
        ? [{ kind: "project", projectId: id }]
        : []),
    ]);
    const offset = live.frames.length,
      commandOffset = state.commands.length,
      authorityOffset = state.authority.length;
    const response = await visit(name, method, url, options);
    const after = await snapshot();
    await live.ping(name + " after");
    const events = live.frames
      .slice(offset)
      .filter((frame) => frame.type === "event" && frame.resource === "project")
      .map(({ cursor, ...event }) => f.normalize(event));
    const expectedEvent = mutation
      ? [
          {
            type: "event",
            scope:
              mutation === "order"
                ? { kind: "current-user" }
                : { kind: "project", projectId: id },
            resource: "project",
            action: "invalidated",
            entityId: mutation === "order" ? null : id,
            revision: null,
            payload: null,
            occurredAt: "<timestamp>",
          },
        ]
      : [];
    assert.deepEqual(
      events,
      f.normalize(expectedEvent),
      name + " exact project Live publication",
    );
    const commands = state.commands.slice(commandOffset);
    const authority = [];
    if (!mutation) {
      assert.deepEqual(after, before, name + " preserves durable state");
      if ((options.status ?? 200) !== 502)
        assert.deepEqual(commands, [], name + " has no worker side effects");
    } else if (mutation === "preference") {
      const expected = structuredClone(before);
      const target = expected.projects.find((p) => p.id === id);
      const updated = after.projects.find((p) => p.id === id);
      assert.ok(target && updated);
      const field = url.endsWith("preferred-worker")
        ? "preferred_worker_id"
        : "worktree_policy";
      target[field] =
        options.json.workerId === undefined
          ? options.json.policy
          : options.json.workerId;
      // JavaScript strings cross the PostgreSQL UTF-8 boundary here.
      if (typeof target[field] === "string")
        target[field] = target[field].toWellFormed();
      target.updated_at = updated.updated_at;
      if (
        field === "worktree_policy" &&
        before.projects.find((p) => p.id === id).worktree_policy !==
          target.worktree_policy
      ) {
        for (const chat of expected.chats)
          if (chat.project_id === id && chat.context_kind === "project")
            chat.computer_use_authority_generation += 1;
        authority.push({ kind: "project", projectId: id });
      }
      assert.deepEqual(
        after,
        expected,
        name + " updates only the selected preference/timestamp",
      );
      assert.deepEqual(commands, []);
    } else if (mutation === "order") {
      const expected = structuredClone(before);
      for (const p of expected.projects)
        if (p.owner_id === f.owner) p.position = options.json.ids.indexOf(p.id);
      assert.deepEqual(
        after,
        expected,
        name +
          " updates positions only, retaining timestamps and other tenants",
      );
      assert.deepEqual(commands, []);
    } else {
      assert.ok(before.projects.some((p) => p.id === id));
      assert.ok(!after.projects.some((p) => p.id === id));
      for (const table of [
        "projects",
        "chats",
        "terminals",
        "remote_surfaces",
        "explorers",
        "code_tabs",
        "browsers",
        "project_views",
        "project_sources",
        "project_workspace_memberships",
        "project_replica_jobs",
        "project_github_conversion_jobs",
      ]) {
        assert.deepEqual(
          after[table],
          before[table].filter(
            (row) => (table === "projects" ? row.id : row.project_id) !== id,
          ),
          name + " exact cascade " + table,
        );
      }
      const sources = new Set(
        before.project_sources
          .filter((s) => s.project_id === id)
          .map((s) => s.id),
      );
      authority.push(
        ...before.chats
          .filter((c) => c.project_id === id)
          .map((c) => ({ kind: "chat", chatId: c.id })),
      );
      assert.deepEqual(
        after.project_worktrees,
        before.project_worktrees.filter(
          (w) => !sources.has(w.project_source_id),
        ),
        name + " exact worktree cascade",
      );
      const expected = structuredClone(before.settings);
      for (const settings of expected ?? [])
        if (
          settings.user_id === f.owner &&
          settings.mobile_project_tab_configurations
        )
          delete settings.mobile_project_tab_configurations[id];
      assert.deepEqual(
        after.settings,
        expected,
        name + " clears only the selected mobile project configuration",
      );
      const types = commands.map((c) => c.type);
      if (!options.json?.deleteLocalFiles)
        assert.ok(
          !types.some((t) =>
            ["project.folder.delete", "project.files.delete"].includes(t),
          ),
          name + " preserves filesystem",
        );
      const fileIndex = types.findIndex((t) => t.startsWith("project."));
      if (fileIndex !== -1)
        assert.ok(
          types.slice(fileIndex).every((t) => t !== "terminal.close"),
          name + " terminal closure precedes filesystem deletion",
        );
    }
    if (authority.length)
      await eventually(
        () => state.authority.slice(authorityOffset),
        (actual) =>
          assert.deepEqual(
            actual,
            authority,
            name + " post-commit authority revocation",
          ),
      );
    assert.deepEqual(
      state.authority.slice(authorityOffset),
      authority,
      name + " exact preview revocation",
    );
    const requestId = [...f.requests].find(([, label]) => label === name)[0];
    let audits;
    await eventually(
      async () =>
        (audits = (await auditRows(f)).filter(
          (a) => a.requestId === requestId,
        )),
      (rows) => assert.equal(rows.length, 1, name + " persisted audit"),
    );
    const audit = audits[0];
    const resourceId =
      name.startsWith("unsupported ") ||
      mutation === "order" ||
      (url === "/api/projects/order" && method === "PATCH")
        ? null
        : id;
    assert.equal(audit.resource.id, resourceId, name + " exact audit identity");
    result.cases.push({
      name,
      commands: f.normalize(commands),
      authority,
      events,
      before: comparable(before, f),
      after: comparable(after, f),
      audit: {
        action: audit.action,
        result: audit.result,
        resource: audit.resource,
      },
    });
    await writeFile(
      path.join(
        root,
        profile,
        f.kind,
        "cases",
        String(result.cases.length).padStart(3, "0") + ".json",
      ),
      JSON.stringify({ name, before, after, commands, audit }, null, 2) + "\n",
    );
    return response;
  };
  try {
    await f.start();
    await mkdir(path.join(root, profile, f.kind, "cases"), { recursive: true });
    log = createWriteStream(path.join(root, profile, f.kind, "server.log"));
    log.write(f.server.diagnostics());
    f.server.child.stdout.on("data", (chunk) => log.write(chunk));
    f.server.child.stderr.on("data", (chunk) => log.write(chunk));
    const auth =
      profile === "accounts"
        ? await visit("register", "POST", "/api/auth/register", {
            status: 201,
            json: {
              email: "project-administration@example.invalid",
              displayName: "Project administration",
              password,
            },
          })
        : profile === "password"
          ? await visit("login", "POST", "/api/auth/login", {
              json: { password },
            })
          : await visit("session", "GET", "/api/auth/session");
    f.owner = auth.currentUser?.id ?? localOwner;
    const handler = async (command) => {
      state.commands.push(command);
      if (state.intercept) await state.intercept(command);
      if (state.fail === command.type)
        throw new Error("Controlled " + command.type + " failure");
      return command.type === "project.folder.delete"
        ? (state.folderResult ?? { deleted: true })
        : { closed: true };
    };
    worker = await managementWorker({
      f,
      visit,
      root: path.join(root, profile, f.kind),
      state,
      handlers: {
        ...Object.fromEntries(
          [
            "terminal.close",
            "surface.close",
            "project.folder.delete",
            "project.files.delete",
          ].map((type) => [type, handler]),
        ),
        "computer-use.preview.revoke": async (command) => {
          assert.equal(command.ownerId, f.owner);
          assert.match(command.serverId, /^[0-9a-f-]{36}$/);
          state.authorityServer ??= command.serverId;
          assert.equal(command.serverId, state.authorityServer);
          state.authority.push(command.scope);
          return { closed: true };
        },
      },
    });
    worker.report.managedFolders = {
      ...worker.report.managedFolders,
      remove: true,
    };
    await worker.pulse();
    await f.sql(seed(f.owner));
    live = new LiveProbe(f);
    await live.open();
    await live.initialized();
    // Project scopes are authorized on subscription. Include future disposable
    // IDs only once they exist, rather than weakening subscription guards.
    await live.subscribed("administration scopes", [
      { kind: "current-user" },
      ...Object.entries(projects)
        .filter(([k]) => k !== "other")
        .map(([, projectId]) => ({ kind: "project", projectId })),
    ]);
    // The existing current-user subscription receives project invalidations.
    await preferenceCases({ f, settle, snapshot, result });
    await removalCases({ f, settle, snapshot, state, result });
    if (values.boundaries)
      await administrationBoundaries({
        f,
        live,
        state,
        snapshot,
        visit,
        result,
      });
    result.backgroundCommands = f.normalize(state.background);
    result.liveHistory = live.history;
    result.passed = true;
  } catch (error) {
    result.failure = error.stack;
    throw error;
  } finally {
    worker?.close();
    if (live) await live.close();
    const child = f.server?.child;
    try {
      await f.close();
    } catch (error) {
      result.shutdownFailure = error.stack;
      if (!result.failure) throw error;
    } finally {
      if (child)
        result.serverExit = { code: child.exitCode, signal: child.signalCode };
      if (log) await new Promise((resolve) => log.end(resolve));
    }
    if (child && !result.failure)
      assert.deepEqual(result.serverExit, { code: 0, signal: null });
  }
}
let pg;
try {
  let executable;
  if (values.runtime !== "node") {
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
    : ["development", "password", "accounts"]) {
    const cell = { profile, runtimes: [] };
    report.profiles.push(cell);
    let reference;
    for (const kind of values.runtime ? [values.runtime] : ["node", "rust"]) {
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
        auditObservations: true,
        environment: {
          CANTRIP_AUTH_MODE: profile === "development" ? "none" : profile,
          CANTRIP_FIXTURE_LOGGING: "true",
          CANTRIP_REGISTRATION_ENABLED: "true",
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
      if (kind === "rust") f.auditReference = reference;
      else reference = f;
      // A Rust-only diagnostic still uses production completion, then reads
      // persisted audits directly; no Source result is fabricated.
      if (values.runtime === "rust") f.auditObservations = false;
      const result = { kind, http: [], cases: [] };
      cell.runtimes.push(result);
      await run(f, profile, result);
    }
    if (cell.runtimes.length === 2) {
      assert.deepEqual(
        cell.runtimes[1].http,
        cell.runtimes[0].http,
        profile + " complete HTTP contracts",
      );
      assert.deepEqual(
        cell.runtimes[1].cases,
        cell.runtimes[0].cases,
        profile + " state, worker commands, Live and audits",
      );
      assert.deepEqual(
        cell.runtimes[1].boundaries,
        cell.runtimes[0].boundaries,
        profile +
          " notification validation, pending terminal replies and caller disappearance",
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
