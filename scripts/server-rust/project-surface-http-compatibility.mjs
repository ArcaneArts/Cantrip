import {
  streamingHttpRequest,
  headersOnlyHttpRequest,
} from "./streaming-http-request.mjs";
// Actual HTTP, unchanged worker transport, and response-completion Live barriers.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { LiveProbe, currentUser } from "./live-sockets.mjs";
import { observeResponseCompletion } from "./response-observations.mjs";
import {
  targetStateSql,
  localOwner,
  otherOwner,
  label,
  state,
  json,
  literal,
  stamp,
} from "./project-target-state.mjs";
import { password } from "./security-fixtures.mjs";
import { fileDocumentWireFixtures } from "./file-document-wire-fixtures.mjs";
import { fileDocumentHttpWorker } from "./file-document-http-worker.mjs";
import { eventually } from "./full-worker.mjs";
const option = (k) => {
  const i = process.argv.indexOf(k);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-project-surfaces-http-"),
);
const report = {
  suite: "project-surface-http",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
const ids = [1, 2, 3, 4].map(
  (i) => `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
);
const resources = new Set([
  "explorer",
  "code-tab",
  "project-view",
  "project-tab-layout",
]);
let pg, failure;
try {
  const executable = await buildRustServer(),
    repositoryBinary = await buildRustExample("project-repository-fixture"),
    passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"]) {
    const runtimes = [];
    report.profiles.push({ profile, runtimes });
    for (const kind of ["node", "rust"]) {
      const databaseUrl =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const fixture = new HttpFixture({
        kind,
        executable,
        root,
        name: profile,
        databaseMode,
        responseObservations: true,
        environment: {
          CANTRIP_AUTH_MODE: profile,
          CANTRIP_REGISTRATION_ENABLED: "true",
          CANTRIP_API_BODY_LIMIT_BYTES: "65536",
          ...(profile === "password"
            ? { CANTRIP_PASSWORD_HASH: passwordHash }
            : {}),
          ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
          ...(kind === "rust" && databaseMode === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      });
      const result = { kind, observations: [], changes: [], commands: [] };
      runtimes.push(result);
      let repo, live, worker;
      const visit = async (name, method, url, options = {}) => {
        const events = () =>
          live.history.filter(
            (e) => e.type === "event" && resources.has(e.resource),
          );
        const before = live ? events().length : 0;
        const observed = await fixture.observe(name, method, url, {
          csrf:
            !["GET", "HEAD"].includes(method) &&
            !!fixture.client(options.client).csrf,
          ...options,
        });
        result.observations.push({ name, ...observed });
        if (live) {
          if (kind === "node") await observeResponseCompletion(fixture, name);
          await live.ping(name + " completed");
          const changes = events()
            .slice(before)
            .map(
              ({ resource, scope, entityId, revision, payload, action }) => ({
                resource,
                scope,
                entityId,
                revision,
                payload,
                action,
              }),
            );
          const match =
            /^\/api\/(?:projects\/([^/]+)\/)?(explorers|code-tabs|views|project-views)(?:\/([^/]+))?/.exec(
              url,
            );
          const expected =
            match &&
            !["GET", "HEAD", "OPTIONS"].includes(method) &&
            observed.status < 400
              ? [
                  match[2] === "explorers"
                    ? "explorer"
                    : match[2] === "code-tabs"
                      ? "code-tab"
                      : "project-view",
                  "project-tab-layout",
                ]
              : [];
          assert.deepEqual(
            changes,
            expected.map((resource) => ({
              resource,
              scope: match[1]
                ? { kind: "project", projectId: match[1] }
                : currentUser,
              entityId: match[3] ?? match[1],
              revision: null,
              payload: null,
              action: "invalidated",
            })),
            name + " exact Live publication",
          );
          result.changes.push({ name, events: changes });
        }
        return fixture.records.get(name);
      };
      const openRepo = () =>
        repositoryFixture({
          kind,
          executable: repositoryBinary,
          root: path.join(root, profile),
          databaseMode,
          databaseUrl,
        });
      try {
        await fixture.start();
        let owner = localOwner,
          other = otherOwner;
        if (profile === "accounts") {
          for (const client of ["main", "other"])
            await visit("register " + client, "POST", "/api/auth/register", {
              client,
              json: {
                email: `surface-${client}@example.invalid`,
                displayName: client,
                password,
              },
              status: 201,
            });
          owner = fixture.records.get("register main").currentUser.id;
          other = fixture.records.get("register other").currentUser.id;
        } else if (profile === "password")
          await visit("login", "POST", "/api/auth/login", {
            json: { password },
          });
        else await visit("session", "GET", "/api/auth/session");
        await fixture.close();
        repo = await openRepo();
        for (const sql of targetStateSql(owner, other)) await repo.seed(sql);
        const seeds = targetStateSql(owner, other);
        // A separate UUID-bound checkout exercises the actual binding schema.
        for (const [prefix, transform] of [
          [
            "INSERT INTO projects(id",
            (sql) =>
              sql
                .replace("VALUES('github'", `VALUES('${ids[0]}'`)
                .replace("github-blind-index", "bound-blind-index"),
          ],
          [
            "INSERT INTO project_sources(id",
            (sql) =>
              sql
                .replaceAll("github-alpha", "bound-source")
                .replace("'github'", literal(ids[0])),
          ],
          [
            "INSERT INTO project_worktrees(id",
            (sql) =>
              sql
                .replaceAll("github-alpha-main", ids[1])
                .replaceAll("github-alpha", "bound-source"),
          ],
          [
            "INSERT INTO explorers(id",
            (sql) =>
              sql
                .replace(
                  "VALUES('explorer','github'",
                  `VALUES('bound-explorer','${ids[0]}'`,
                )
                .replaceAll("github-alpha-main", ids[1]),
          ],
        ]) {
          const sql = seeds.find(
            (sql) => sql.startsWith(prefix) && sql.includes("github"),
          );
          assert.ok(sql);
          await repo.seed(transform(sql));
        }

        await repo.seed(
          `INSERT INTO project_views(id,project_id,kind,worktree_id,protected_label,created_at,updated_at) VALUES('history','github','history','github-alpha-main',${json(label("project-view"))},${literal(stamp)},${literal(stamp)})`,
        );
        await repo.close();
        repo = undefined;
        await fixture.start();
        live = await new LiveProbe(fixture).open();
        await live.initialized();
        await live.subscribed("surface-http", [
          currentUser,
          { kind: "project", projectId: "github" },
          { kind: "project", projectId: "folder" },
        ]);
        worker = await fileDocumentHttpWorker({
          fixture,
          root: path.join(root, profile, kind, "worker"),
          visit,
          result,
          operationType: "explorer.operation",
        });
        for (const projectId of ["explorers", "code-tabs"])
          await visit(
            `view project ID resembles route ${projectId}`,
            "POST",
            `/api/projects/${projectId}/views`,
            {
              json: {
                id: ids[3],
                kind: "history",
                titleProtection: label("project-view"),
              },
              status: 404,
            },
          );
        for (const id of ["pin", "worktree", "view-state", "operation"])
          await visit(
            `Explorer ID resembles action ${id}`,
            "PATCH",
            `/api/explorers/${id}`,
            {
              json: { titleProtection: label("explorer") },
              status: 404,
            },
          );
        for (const resource of ["code-tabs", "project-views"])
          await visit(
            `${resource} ID resembles action`,
            "PATCH",
            `/api/${resource}/worktree`,
            {
              json: {
                titleProtection: label(
                  resource === "code-tabs" ? "code-tab" : "project-view",
                ),
              },
              status: 404,
            },
          );
        for (const [index, collection, resource, subject, record] of [
          [0, "explorers", "explorers", "explorer", "explorer"],
          [1, "code-tabs", "code-tabs", "code", "code-tab"],
          [2, "views", "project-views", "history", "project-view"],
        ]) {
          const list = `/api/projects/github/${collection}`,
            item = `/api/${resource}/${subject}`;
          const titleProtection = label(record),
            extra =
              collection === "explorers"
                ? { stateProtection: state("explorer-state") }
                : collection === "views"
                  ? { kind: "history" }
                  : {};
          const input = { id: ids[index], titleProtection, ...extra };
          await visit(collection + " list", "GET", list);
          await visit(collection + " HEAD", "HEAD", list);
          await visit(
            collection + " foreign list",
            "GET",
            `/api/projects/other/${collection}`,
          );
          await visit(
            collection + " missing list",
            "GET",
            `/api/projects/missing/${collection}`,
          );
          await visit(collection + " invalid create", "POST", list, {
            json: {},
            status: 400,
          });
          await visit(
            collection + " wrong title classification",
            "PATCH",
            item,
            { json: { titleProtection: label("chat") }, status: 400 },
          );
          await visit(
            collection + " wrong owner",
            "PATCH",
            `/api/${resource}/other-${subject}`,
            { json: { titleProtection }, status: 404 },
          );
          await visit(collection + " update", "PATCH", item, {
            json: { titleProtection },
          });
          await visit(collection + " empty update", "PATCH", item, {
            json: {},
            status: 400,
          });
          await visit(collection + " conflicting destination", "POST", list, {
            json: { ...input, paneId: "p", targetRegion: "center" },
            status: 400,
          });
          await visit(collection + " invalid pane", "POST", list, {
            json: { ...input, paneId: "missing" },
            status: 400,
          });
          await visit(collection + " create", "POST", list, {
            json: input,
            status: 201,
          });
          await visit(collection + " duplicate", "POST", list, {
            json: input,
            status: 500,
          });
          await visit(collection + " retarget", "PATCH", item + "/worktree", {
            json: {
              worktreeId: "github-beta-main",
              ...(collection === "explorers"
                ? { stateProtection: state("explorer-state") }
                : {}),
            },
          });
          await visit(
            collection + " missing target",
            "PATCH",
            item + "/worktree",
            {
              json: {
                worktreeId: "missing",
                ...(collection === "explorers"
                  ? { stateProtection: state("explorer-state") }
                  : {}),
              },
              status: 404,
            },
          );
          if (profile !== "none") {
            await visit(collection + " anonymous", "GET", list, {
              client: "anonymous",
              status: 401,
            });
            await visit(collection + " CSRF", "PATCH", item, {
              json: { titleProtection },
              csrf: false,
              status: 403,
            });
          }
          if (profile === "accounts")
            await visit(collection + " other owner update", "PATCH", item, {
              client: "other",
              json: { titleProtection },
              status: 404,
            });
          await visit(
            collection + " delete created",
            "DELETE",
            `/api/${resource}/${ids[index]}`,
            { status: 204 },
          );
          await visit(
            collection + " delete again",
            "DELETE",
            `/api/${resource}/${ids[index]}`,
            { status: 404 },
          );
        }
        await visit(
          "Explorer state",
          "PATCH",
          "/api/explorers/explorer/view-state",
          {
            json: {
              stateProtection: state("explorer-state"),
              fileMode: "edit",
            },
          },
        );
        await visit("Explorer pin", "POST", "/api/explorers/explorer/pin", {
          json: {
            titleProtection: label("explorer"),
            stateProtection: state("explorer-state"),
            fileMode: "edit",
            targetRegion: "center",
          },
        });
        await visit(
          "Explorer pin retry",
          "POST",
          "/api/explorers/explorer/pin",
          {
            json: {
              titleProtection: label("explorer"),
              stateProtection: state("explorer-state"),
              fileMode: "visual",
              paneId: "missing",
            },
          },
        );
        await visit(
          "Explorer return to connected worker",
          "PATCH",
          "/api/explorers/explorer/worktree",
          {
            json: {
              worktreeId: "github-alpha-main",
              stateProtection: state("explorer-state"),
            },
          },
        );
        const operation =
          fileDocumentWireFixtures().surfaceStreamWireRequestSchema[0];
        await visit(
          "Explorer stale binding",
          "POST",
          "/api/explorers/explorer/operation",
          {
            json: {
              ...operation,
              binding: {
                workerId: "alpha",
                projectId: ids[0],
                worktreeId: ids[1],
              },
            },
            status: 409,
          },
        );
        await visit(
          "Explorer operation",
          "POST",
          "/api/explorers/explorer/operation",
          { json: operation },
        );
        const binding = {
          workerId: "alpha",
          projectId: ids[0],
          worktreeId: ids[1],
        };
        await visit(
          "Explorer matching binding",
          "POST",
          "/api/explorers/bound-explorer/operation",
          { json: { ...operation, binding } },
        );
        assert.equal(result.commands.at(-1).root, "/fixture/bound-source");
        assert.equal("binding" in result.commands.at(-1), false);
        for (const [field, value] of [
          ["workerId", "beta"],
          ["projectId", ids[3]],
          ["worktreeId", ids[3]],
        ])
          await visit(
            `Explorer mismatched ${field}`,
            "POST",
            "/api/explorers/bound-explorer/operation",
            {
              json: { ...operation, binding: { ...binding, [field]: value } },
              status: 409,
            },
          );
        await visit(
          "Explorer opaque operation exceeds general limit",
          "POST",
          "/api/explorers/explorer/operation",
          {
            json: {
              ...operation,
              protectedRequest: {
                ...operation.protectedRequest,
                envelope: {
                  ...operation.protectedRequest.envelope,
                  ciphertext: "A".repeat(100000),
                },
              },
            },
          },
        );

        for (const mode of ["error", "invalid", "extra"]) {
          worker.mode = mode;
          await visit(
            "Explorer worker " + mode,
            "POST",
            "/api/explorers/explorer/operation",
            { json: operation, status: 502 },
          );
        }
        worker.mode = "ok";
        await visit(
          "Explorer missing operation",
          "POST",
          "/api/explorers/missing/operation",
          { json: operation, status: 404 },
        );
        await visit(
          "Explorer operation custom body limit",
          "POST",
          "/api/explorers/explorer/operation",
          { json: { ...operation, unknown: "x".repeat(70000) }, status: 400 },
        );
        await visit(
          "Explorer operation oversized body",
          "POST",
          "/api/explorers/explorer/operation",
          {
            json: { ...operation, unknown: "x".repeat(4 * 1024 * 1024) },
            status: 413,
            fetcher: streamingHttpRequest,
          },
        );
        for (const [name, contentType, status] of [
          ["JSON", "application/json", 413],
          ["text", "text/plain", 413],
          ["unsupported", "application/xml", 415],
        ]) {
          await visit(
            `Explorer oversized ${name} headers`,
            "POST",
            "/api/explorers/explorer/operation",
            {
              headers: {
                "content-type": contentType,
                "content-length": String(4 * 1024 * 1024 + 1),
              },
              fetcher: headersOnlyHttpRequest,
              status,
            },
          );
        }
        await visit(
          "history requires git",
          "POST",
          "/api/projects/folder/views",
          {
            json: {
              id: ids[3],
              kind: "history",
              titleProtection: label("project-view"),
            },
            status: 409,
          },
        );
        await visit(
          "issues require GitHub",
          "POST",
          "/api/projects/folder/views",
          {
            json: {
              id: ids[3],
              kind: "issues",
              titleProtection: label("project-view"),
            },
            status: 409,
          },
        );
        await visit(
          "remote desktop rejects retarget",
          "PATCH",
          "/api/project-views/desktop/worktree",
          { json: { worktreeId: "github-alpha-main" }, status: 409 },
        );
        await visit(
          "remote desktop deletion",
          "DELETE",
          "/api/project-views/desktop",
          { status: 204 },
        );
        await eventually(
          () => worker.surfaceCommands,
          (commands) =>
            assert.deepEqual(commands, [
              { type: "surface.close", surfaceId: "desktop" },
            ]),
        );
        await visit(
          "remote desktop deletion retry",
          "DELETE",
          "/api/project-views/desktop",
          { status: 404 },
        );
        await worker.close();
        result.surfaceCommands = fixture.normalize(worker.surfaceCommands);
        assert.equal(result.surfaceCommands.length, 1);
        worker = undefined;
        await visit(
          "offline Explorer operation",
          "POST",
          "/api/explorers/explorer/operation",
          { json: operation, status: 503 },
        );
        result.commands = fixture.normalize(result.commands);
      } finally {
        await worker?.close();
        await live?.close();
        await fixture.close();
        await repo?.close();
      }
    }
    for (const key of [
      "observations",
      "changes",
      "commands",
      "surfaceCommands",
    ])
      assert.deepEqual(runtimes[1][key], runtimes[0][key], profile + " " + key);
  }
} catch (error) {
  failure = error;
  report.failure = error.stack;
  report.retainedRoot = root;
} finally {
  try {
    await pg?.close();
  } catch (error) {
    failure ??= error;
  }
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
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
      observations: p.runtimes[0].observations.length,
      commands: p.runtimes[0].commands.length,
    })),
  }),
);
