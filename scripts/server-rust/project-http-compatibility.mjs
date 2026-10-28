// Production HTTP routes and the existing Node worker transport. This exercises
// resource reads/placement; filesystem execution and the full worker remain separate.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { heartbeat } from "./security-fixtures.mjs";
import {
  targetStateSql,
  localOwner,
  otherOwner,
} from "./project-target-state.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-project-http-"));
const report = {
  suite: "actual-project-http-placement",
  databaseMode,
  completeReplacement: false,
  runtimes: [],
};
let pg, failure;
async function eventually(read, check) {
  const end = Date.now() + 15000;
  for (;;) {
    const value = await read();
    try {
      check(value);
      return value;
    } catch (e) {
      if (Date.now() >= end) throw e;
    }
    await delay(15);
  }
}
try {
  const executable = await buildRustServer(),
    repoExecutable = await buildRustExample("project-repository-fixture");
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "accounts"]) {
    for (const kind of ["node", "rust"]) {
      const name = "projects-" + profile,
        databaseUrl =
          pg && (kind === "node" || databaseMode === "postgres")
            ? await pg.database()
            : undefined;
      const fixture = new HttpFixture({
        kind,
        executable,
        root,
        name,
        databaseMode,
        environment: {
          CANTRIP_AUTH_MODE: profile,
          CANTRIP_REGISTRATION_ENABLED: "true",
          ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
          ...(kind === "rust" && databaseMode === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      });
      const result = {
        kind,
        profile,
        observations: [],
        workerConnections: 0,
        backgroundCommands: [],
      };
      report.runtimes.push(result);
      let repo, worker;
      const visit = async (label, method, target, options = {}) => {
        const response = await fixture.observe(label, method, target, {
          compareContentLength: method === "HEAD",
          csrf:
            !["GET", "HEAD"].includes(method) &&
            !!fixture.client(options.client).csrf,
          ...options,
        });
        result.observations.push({ label, ...response });
        return fixture.records.get(label);
      };
      const catalog = () =>
        fetch(
          fixture.server.origin + "/api/projects/github/execution-targets",
          {
            headers: {
              origin: "http://127.0.0.1:5173",
              cookie: [...fixture.client().cookies]
                .map(([k, v]) => `${k}=${v}`)
                .join("; "),
            },
          },
        ).then((r) => r.json());
      try {
        await fixture.start();
        let owner = localOwner,
          other = otherOwner;
        if (profile === "accounts") {
          for (const client of ["main", "second"])
            await visit("register " + client, "POST", "/api/auth/register", {
              client,
              status: 201,
              json: {
                displayName: "Project " + client,
                email: `project-${client}@example.invalid`,
                password: "isolated project fixture password",
              },
            });
          owner = fixture.records.get("register main").currentUser.id;
          other = fixture.records.get("register second").currentUser.id;
        } else await visit("session", "GET", "/api/auth/session");
        await fixture.close();
        repo = await repositoryFixture({
          kind,
          executable: repoExecutable,
          root: path.join(root, name),
          databaseMode,
          databaseUrl,
        });
        for (const sql of targetStateSql(owner, other)) await repo.seed(sql);
        await repo.close();
        repo = undefined;
        await fixture.start();
        await visit("project list", "GET", "/api/projects");
        await visit("project list HEAD", "HEAD", "/api/projects");
        for (const project of ["github", "folder", "local-git"])
          await visit(
            "offline catalog " + project,
            "GET",
            `/api/projects/${project}/execution-targets`,
          );
        for (const project of ["missing", "other"])
          await visit(
            "missing/foreign catalog " + project,
            "GET",
            `/api/projects/${project}/execution-targets`,
            { status: 404 },
          );
        if (profile === "accounts") {
          await visit("second account project list", "GET", "/api/projects", {
            client: "second",
          });
          await visit(
            "second account denied catalog",
            "GET",
            "/api/projects/github/execution-targets",
            { client: "second", status: 404 },
          );
        }
        await visit(
          "offline default placement",
          "POST",
          "/api/projects/github/placement/resolve",
          { status: 409, json: { surfaceKind: "terminal" } },
        );
        await visit(
          "offline explicit target",
          "POST",
          "/api/projects/github/execution-targets/resolve",
          {
            status: 409,
            json: {
              target: {
                kind: "worker",
                projectId: "github",
                workerId: "alpha",
              },
            },
          },
        );
        await visit(
          "offline explicit opt-in",
          "POST",
          "/api/projects/github/execution-targets/resolve",
          {
            json: {
              target: {
                kind: "worker",
                projectId: "github",
                workerId: "alpha",
              },
              allowUnavailable: true,
            },
          },
        );
        await visit(
          "enrollment code",
          "POST",
          "/api/workers/enrollment-codes",
          { status: 201, json: { label: "Project target transport" } },
        );
        await visit(
          "enrolled credential",
          "POST",
          "/api/internal/workers/enroll",
          {
            status: 201,
            client: "worker",
            json: {
              code: fixture.records.get("enrollment code").code,
              heartbeat: {
                ...heartbeat,
                workerId: "alpha",
                name: "alpha worker",
                remoteSurfaces: {
                  ...heartbeat.remoteSurfaces,
                  browser: true,
                  desktop: true,
                },
              },
            },
          },
        );
        await visit(
          "credential",
          "POST",
          "/api/workers/alpha/credentials/rotate",
          { json: { label: "Project target transport" } },
        );
        const config = {
          dataDirectory: path.join(root, name, kind, "worker-client"),
          name: "Project target transport",
          serverUrl: fixture.server.origin,
          enrollmentCode: null,
          replacement: null,
          token: fixture.records.get("credential").credential,
          tokenSource: "persisted",
          workerId: "alpha",
        };
        saveWorkerCredential({
          credential: config.token,
          dataDirectory: config.dataDirectory,
          serverUrl: config.serverUrl,
          workerId: config.workerId,
        });
        worker = new WorkerConnection(
          config,
          async (command) => {
            result.backgroundCommands.push(command.type);
            throw new Error(
              "Metadata fixture does not implement worker commands.",
            );
          },
          undefined,
          undefined,
          undefined,
          1000,
          () => result.workerConnections++,
        );
        worker.start();
        await eventually(
          () => result.workerConnections,
          (n) => assert.equal(n, 1),
        );
        await visit(
          "connected catalog",
          "GET",
          "/api/projects/github/execution-targets",
        );
        await visit(
          "connected catalog HEAD",
          "HEAD",
          "/api/projects/github/execution-targets",
        );
        for (const surfaceKind of [
          "chat",
          "terminal",
          "explorer",
          "code",
          "browser",
          "remote-desktop",
          "remote-surface",
        ])
          await visit(
            "place " + surfaceKind,
            "POST",
            "/api/projects/github/placement/resolve",
            { json: { surfaceKind } },
          );
        const targets = [
          { kind: "project", projectId: "github" },
          { kind: "worker", projectId: "github", workerId: "alpha" },
          {
            kind: "replica",
            projectId: "github",
            projectReplicaId: "github-alpha",
          },
          {
            kind: "worktree",
            projectId: "github",
            worktreeId: "github-alpha-main",
          },
          ...[
            ["chat", "chat"],
            ["terminal", "terminal"],
            ["explorer", "explorer"],
            ["code", "code"],
            ["browser", "browser"],
            ["remote-desktop", "desktop"],
            ["remote-surface", "remote"],
          ].map(([surfaceKind, surfaceId]) => ({
            kind: "surface",
            projectId: "github",
            surfaceKind,
            surfaceId,
          })),
        ];
        for (const target of targets)
          await visit(
            "resolve " + (target.surfaceKind ?? target.kind),
            "POST",
            "/api/projects/github/execution-targets/resolve",
            { json: { target } },
          );
        await visit(
          "UTF-16 worker map",
          "POST",
          "/api/projects/github/placement/resolve",
          {
            status: 409,
            json: {
              surfaceKind: "terminal",
              target: {
                kind: "worker",
                projectId: "github",
                workerId: "\ud800",
              },
            },
          },
        );
        await visit(
          "UTF-16 worker SQL",
          "POST",
          "/api/projects/github/execution-targets/resolve",
          {
            json: {
              target: {
                kind: "worker",
                projectId: "github",
                workerId: "\ud800",
              },
              allowUnavailable: true,
            },
          },
        );
        await visit(
          "UTF-16 surface SQL",
          "POST",
          "/api/projects/github/execution-targets/resolve",
          {
            json: {
              target: {
                kind: "surface",
                projectId: "github",
                surfaceKind: "terminal",
                surfaceId: "\ud800",
              },
            },
          },
        );
        for (const input of [
          undefined,
          null,
          [],
          {},
          true,
          { surfaceKind: "unknown" },
          { surfaceKind: "terminal", extra: 1 },
          { surfaceKind: "terminal", target: null },
          {
            surfaceKind: "terminal",
            target: { kind: "worker", projectId: "github", workerId: "" },
          },
        ])
          await visit(
            "invalid placement " + JSON.stringify(input),
            "POST",
            "/api/projects/github/placement/resolve",
            { status: 400, ...(input === undefined ? {} : { json: input }) },
          );
        for (const input of [
          undefined,
          null,
          [],
          {},
          true,
          { target: null },
          { target: { kind: "unknown" } },
          { target: targets[0], allowUnavailable: null },
          { target: targets[0], extra: 1 },
        ])
          await visit(
            "invalid target " + JSON.stringify(input),
            "POST",
            "/api/projects/github/execution-targets/resolve",
            { status: 400, ...(input === undefined ? {} : { json: input }) },
          );
        await visit(
          "bad JSON",
          "POST",
          "/api/projects/github/execution-targets/resolve",
          {
            status: 400,
            raw: "{",
            headers: { "content-type": "application/json" },
          },
        );
        await visit(
          "target mismatch",
          "POST",
          "/api/projects/github/execution-targets/resolve",
          {
            status: 409,
            json: {
              target: { kind: "worker", projectId: "other", workerId: "alpha" },
            },
          },
        );
        await visit(
          "missing project placement",
          "POST",
          "/api/projects/missing/placement/resolve",
          { status: 404, json: { surfaceKind: "terminal" } },
        );
        await visit(
          "missing project target",
          "POST",
          "/api/projects/missing/execution-targets/resolve",
          {
            status: 404,
            json: { target: { kind: "project", projectId: "missing" } },
          },
        );
        await visit(
          "foreign surface",
          "POST",
          "/api/projects/github/execution-targets/resolve",
          {
            status: 409,
            json: {
              target: {
                kind: "surface",
                projectId: "github",
                surfaceKind: "terminal",
                surfaceId: "other-terminal",
              },
            },
          },
        );
        worker.close();
        worker = undefined;
        await eventually(catalog, (body) =>
          assert.equal(
            body.targets.find(
              (t) =>
                t.resourceKind === "worker" && t.target.workerId === "alpha",
            ).availability,
            "worker-offline",
          ),
        );
        await visit(
          "disconnected catalog",
          "GET",
          "/api/projects/github/execution-targets",
        );
        await fixture.close();
        await fixture.start();
        await visit("retained project list", "GET", "/api/projects");
        await visit(
          "retained offline catalog",
          "GET",
          "/api/projects/github/execution-targets",
        );
      } finally {
        worker?.close();
        await repo?.close();
        await fixture.close();
      }
    }
    const [reference, actual] = report.runtimes.filter(
      (r) => r.profile === profile,
    );
    assert.deepEqual(
      actual.observations,
      reference.observations,
      profile + " actual HTTP contracts",
    );
  }
} catch (e) {
  failure = e;
  report.failure = { message: e.message, stack: e.stack };
} finally {
  await pg?.close();
  await rm(root, { recursive: true, force: true });
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    runtimes: report.runtimes.map((r) => ({
      kind: r.kind,
      profile: r.profile,
      cases: r.observations.length,
      connections: r.workerConnections,
    })),
  }),
);
