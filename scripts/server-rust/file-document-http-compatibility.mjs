// Real HTTP, authentication, worker transport and retained document state.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { LiveProbe, currentUser } from "./live-sockets.mjs";
import {
  targetStateSql,
  localOwner,
  otherOwner,
  literal,
  json,
  state,
  stamp,
} from "./project-target-state.mjs";
import { password } from "./security-fixtures.mjs";
import { fileDocumentWireFixtures } from "./file-document-wire-fixtures.mjs";
import { fileDocumentHttpWorker } from "./file-document-http-worker.mjs";
import { eventually } from "./full-worker.mjs";
import {
  streamingHttpRequest,
  headersOnlyHttpRequest,
} from "./streaming-http-request.mjs";
const option = (k) => {
  const i = process.argv.indexOf(k);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-file-document-http-"));
const started = Date.now();
const report = {
  suite: "actual-file-document-http",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
const ids = Array.from(
  { length: 8 },
  (_, i) => `dddddddd-dddd-4ddd-8ddd-${String(i + 1).padStart(12, "0")}`,
);
const input = (i = 0, changes = {}) => ({
  id: ids[i],
  worktreeId: "github-alpha-main",
  stateProtection: state("file-document-state"),
  ...changes,
});
const requestBody = () =>
  fileDocumentWireFixtures().surfaceStreamWireRequestSchema[0];
let pg, failure;
try {
  const executable = await buildRustServer(),
    repositoryBinary = await buildRustExample("project-repository-fixture");
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "accounts"]) {
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
        observations: [],
        commands: [],
        events: [],
        changes: [],
        stored: [],
      };
      runtimes.push(result);
      let repo, worker, live;
      const openRepo = () =>
        repositoryFixture({
          kind,
          executable: repositoryBinary,
          root: path.join(root, profile),
          databaseMode,
          databaseUrl,
        });
      const visit = async (name, method, url, options = {}) => {
        const documentEvents = () =>
          live.history.filter(
            (e) => e.type === "event" && e.resource === "file-document",
          );
        const before = live ? documentEvents().length : 0;
        const observed = await fixture.observe(name, method, url, {
          csrf:
            !["GET", "HEAD"].includes(method) &&
            !!fixture.client(options.client).csrf,
          ...options,
        });
        result.observations.push({ name, ...observed });
        if (live) {
          const created =
            method === "POST" &&
            /^\/api\/projects\/[^/]+\/file-documents$/.test(url) &&
            (options.status ?? 200) < 400;
          if (created)
            await eventually(
              () => documentEvents().length,
              (count) =>
                assert.equal(
                  count,
                  before + 1,
                  name + " committed document event",
                ),
            );
          await live.ping(name);
          const events = documentEvents()
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
          assert.equal(
            events.length,
            created ? 1 : 0,
            name + " exact document invalidation count",
          );
          result.changes.push({ name, events });
        }
        return fixture.records.get(name);
      };
      try {
        await fixture.start();
        let owner = localOwner,
          other = otherOwner;
        if (profile === "accounts") {
          for (const client of ["main", "other"])
            await visit("register " + client, "POST", "/api/auth/register", {
              client,
              json: {
                email: `document-${client}@example.invalid`,
                displayName: client,
                password,
              },
              status: 201,
            });
          owner = fixture.records.get("register main").currentUser.id;
          other = fixture.records.get("register other").currentUser.id;
        } else await visit("session", "GET", "/api/auth/session");
        await fixture.close();
        repo = await openRepo();
        for (const sql of targetStateSql(owner, other)) await repo.seed(sql);
        for (const [i, project, workerId, worktreeId] of [
          [0, "github", "alpha", "github-alpha-main"],
          [1, "github", "alpha", "missing-checkout"],
          [2, "other", "foreign", "other-foreign-main"],
          [3, "github", "missing-worker", "github-alpha-main"],
        ]) {
          await repo.seed(
            `INSERT INTO file_documents(id,project_id,worker_id,worktree_id,protected_state,created_at) VALUES(${literal(ids[i])},${literal(project)},${literal(workerId)},${literal(worktreeId)},${json(state("file-document-state"))},${literal(stamp)})`,
          );
        }
        await repo.seed(
          `CREATE FUNCTION document_http_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${literal(ids[7])} THEN RAISE EXCEPTION 'controlled document HTTP insertion failure'; END IF; RETURN NEW; END $$`,
        );
        await repo.seed(
          "CREATE TRIGGER document_http_reject BEFORE INSERT ON file_documents FOR EACH ROW EXECUTE FUNCTION document_http_reject()",
        );
        await repo.close();
        repo = undefined;
        await fixture.start();
        live = await new LiveProbe(fixture).open();
        await live.initialized();
        await live.subscribed("documents", [
          currentUser,
          { kind: "project", projectId: "github" },
        ]);
        await visit(
          "owned catalog",
          "GET",
          "/api/projects/github/file-documents",
        );
        await visit(
          "missing project catalog",
          "GET",
          "/api/projects/missing/file-documents",
        );
        await visit(
          "foreign project catalog",
          "GET",
          "/api/projects/other/file-documents",
        );
        await visit("owned document", "GET", `/api/file-documents/${ids[0]}`);
        await visit(
          "foreign document",
          "GET",
          `/api/file-documents/${ids[2]}`,
          { status: 404 },
        );
        await visit(
          "missing document",
          "GET",
          `/api/file-documents/${ids[7]}`,
          { status: 404 },
        );
        if (profile === "accounts")
          await visit(
            "other account cannot read owned document",
            "GET",
            `/api/file-documents/${ids[0]}`,
            { client: "other", status: 404 },
          );
        await visit(
          "idempotent retry",
          "POST",
          "/api/projects/github/file-documents",
          { json: input() },
        );
        const changed = structuredClone(input());
        changed.stateProtection.protectedState.envelope.ciphertext =
          "B" +
          changed.stateProtection.protectedState.envelope.ciphertext.slice(1);
        await visit(
          "immutable ciphertext conflict",
          "POST",
          "/api/projects/github/file-documents",
          { json: changed, status: 409 },
        );
        await visit(
          "immutable checkout conflict",
          "POST",
          "/api/projects/github/file-documents",
          { json: input(0, { worktreeId: "github-beta-main" }), status: 409 },
        );
        for (const [name, project, body, status] of [
          ["new document", "github", input(4), 200],
          [
            "foreign project",
            "other",
            input(5, { worktreeId: "other-foreign-main" }),
            404,
          ],
          [
            "foreign checkout",
            "github",
            input(5, { worktreeId: "other-foreign-main" }),
            404,
          ],
          [
            "missing checkout",
            "github",
            input(5, { worktreeId: "missing" }),
            404,
          ],
          ["invalid id", "github", input(5, { id: "invalid" }), 400],
          [
            "invalid classification",
            "github",
            input(5, { stateProtection: state("terminal-state") }),
            400,
          ],
          [
            "unknown field",
            "github",
            { ...input(5), path: "private/file" },
            400,
          ],
          ["real insertion rollback", "github", input(7), 500],
        ])
          await visit(name, "POST", `/api/projects/${project}/file-documents`, {
            json: body,
            status,
          });
        worker = await fileDocumentHttpWorker({
          fixture,
          root: path.join(root, profile, kind, "worker"),
          visit,
          result,
        });
        for (const [name, id, status, body] of [
          ["opaque operation", ids[0], 200, requestBody()],
          ["unavailable checkout", ids[1], 404, requestBody()],
          ["foreign operation", ids[2], 404, requestBody()],
          ["missing worker", ids[3], 404, requestBody()],
          ["missing document operation", ids[6], 404, requestBody()],
          [
            "invalid operation sequence",
            ids[0],
            400,
            { ...requestBody(), sequence: -1 },
          ],
          [
            "unknown operation field",
            ids[0],
            400,
            { ...requestBody(), path: "private/file" },
          ],
          [
            "operation route accepts below 4MiB",
            ids[0],
            400,
            { ...requestBody(), padding: "x".repeat(2 * 1024 * 1024) },
          ],
          [
            "operation route rejects above 4MiB",
            ids[0],
            413,
            { ...requestBody(), padding: "x".repeat(4 * 1024 * 1024) },
          ],
          [
            "operation route rejects midway through 8MiB upload",
            ids[0],
            413,
            { ...requestBody(), padding: "x".repeat(8 * 1024 * 1024) },
          ],
        ])
          await visit(name, "POST", `/api/file-documents/${id}/operation`, {
            json: body,
            status,
            ...(status === 413
              ? {
                  fetcher: async (...args) => {
                    const response = await streamingHttpRequest(...args);
                    assert.equal(response.headers.get("connection"), "close");
                    return response;
                  },
                }
              : {}),
          });
        for (const [name, contentType, status] of [
          ["JSON oversized headers", "application/json", 413],
          ["text oversized headers", "text/plain", 413],
          ["binary oversized headers", "application/octet-stream", 413],
          ["unsupported oversized headers", "application/xml", 415],
          ["missing content type oversized headers", undefined, 415],
        ])
          await visit(
            "operation route rejects " + name + " before reading body",
            "POST",
            `/api/file-documents/${ids[0]}/operation`,
            {
              headers: {
                ...(contentType ? { "content-type": contentType } : {}),
                "content-length": String(4 * 1024 * 1024 + 1),
              },
              fetcher: headersOnlyHttpRequest,
              status,
            },
          );
        for (const mode of ["error", "invalid", "extra"]) {
          worker.mode = mode;
          await visit(
            "worker " + mode,
            "POST",
            `/api/file-documents/${ids[0]}/operation`,
            { json: requestBody(), status: 502 },
          );
        }
        worker.mode = "hold";
        const before = result.commands.length,
          controller = new AbortController(),
          client = fixture.client();
        const caller = fetch(
          fixture.server.origin + `/api/file-documents/${ids[0]}/operation`,
          {
            method: "POST",
            headers: {
              origin: "http://127.0.0.1:5173",
              "content-type": "application/json",
              cookie: [...client.cookies]
                .map(([k, v]) => k + "=" + v)
                .join("; "),
              ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
            },
            body: JSON.stringify(requestBody()),
            signal: controller.signal,
          },
        ).then(
          () => ({}),
          (e) => ({ error: e.name }),
        );
        try {
          await eventually(
            () => result.commands.length,
            (n) => assert.equal(n, before + 1),
          );
          controller.abort();
          assert.deepEqual(await caller, { error: "AbortError" });
        } finally {
          worker.mode = "ok";
          worker.release();
        }
        await visit(
          "next operation after caller disconnect",
          "POST",
          `/api/file-documents/${ids[0]}/operation`,
          { json: requestBody() },
        );
        await worker.close();
        worker = undefined;
        await visit(
          "actual disconnected worker",
          "POST",
          `/api/file-documents/${ids[0]}/operation`,
          { json: requestBody(), status: 503 },
        );
        await live.ping("document event completion");
        result.events = live.history
          .filter(
            (e) =>
              e.type === "event" &&
              ![
                "worker",
                "worker-availability",
                "account-resource-usage",
                "audit-event",
              ].includes(e.resource),
          )
          .map(({ resource, scope, entityId, revision, payload, action }) => ({
            resource,
            scope,
            entityId,
            revision,
            payload,
            action,
          }));
        result.commands = fixture.normalize(result.commands);
        await live.close();
        live = undefined;
        await fixture.close();
        repo = await openRepo();
        const stored = await repo.request({
          op: "query-json",
          sql: "SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY id),'[]') result FROM file_documents d",
        });
        assert.equal(stored.rejected, false, stored.diagnostic);
        result.stored = fixture.normalize(
          stored.value.map((row) => {
            const at = Date.parse(row.created_at);
            assert.ok(Number.isFinite(at), "actual stored document timestamp");
            const fixed = at === Date.parse(stamp);
            if (!fixed)
              assert.ok(
                at >= started - 1000 && at <= Date.now() + 1000,
                "stored creation belongs to this operation",
              );
            return {
              ...row,
              created_at: fixed ? "<fixture-time>" : "<operation-time>",
            };
          }),
        );
        assert.equal(stored.value.length, 5);
        assert.equal(
          stored.value.some((d) => d.id === ids[7]),
          false,
          "failed insertion leaves no document",
        );
      } finally {
        await worker?.close();
        await live?.close();
        await fixture.close();
        await repo?.close();
      }
    }
    for (const key of [
      "observations",
      "commands",
      "events",
      "changes",
      "stored",
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
