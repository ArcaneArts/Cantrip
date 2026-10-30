// Actual requests, cookies, CSRF, persistence, receipt replay and Live barriers.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { LiveProbe, currentUser } from "./live-sockets.mjs";
import { workspaceState, workspaceTab } from "./workspace-wire-fixtures.mjs";
import {
  targetStateSql,
  localOwner,
  otherOwner,
  literal,
  json,
  state,
  stamp,
  label,
} from "./project-target-state.mjs";
import { password } from "./security-fixtures.mjs";
import { streamingHttpRequest } from "./streaming-http-request.mjs";

const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-workspace-http-"));
const report = {
  suite: "actual-workspace-http",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
const base = "/api/projects/github/workspace-layouts/workspace";
const document = "dddddddd-dddd-4ddd-8ddd-000000000041";
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
      const result = { kind, observations: [], changes: [] };
      runtimes.push(result);
      let repo, live;
      const visit = async (name, method, url, options = {}) => {
        const events = () =>
          live.history.filter(
            (e) => e.type === "event" && e.scope.kind === "project",
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
          await live.ping(name);
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
          assert.deepEqual(
            changes,
            [],
            name + " does not invent project invalidations",
          );
          result.changes.push({ name, events: changes });
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
                email: `workspace-${client}@example.invalid`,
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
        repo = await repositoryFixture({
          kind,
          executable: repositoryBinary,
          root: path.join(root, profile),
          databaseMode,
          databaseUrl,
        });
        for (const sql of targetStateSql(owner, other)) await repo.seed(sql);
        await repo.seed(
          `INSERT INTO workspace_layouts(owner_id,project_id,workspace_id,layout) VALUES(${literal(owner)},'github','workspace',${json(workspaceState())}),(${literal(owner)},'github','bad-layout','{}'::jsonb)`,
        );
        await repo.seed(
          `INSERT INTO file_documents(id,project_id,worker_id,worktree_id,protected_state,created_at) VALUES(${literal(document)},'github','alpha','github-alpha-main',${json(state("file-document-state"))},${literal(stamp)})`,
        );
        await repo.seed(
          `INSERT INTO tab_groups(id,project_id,region,position,anchor_tab_key,created_at,updated_at) VALUES('invalid-center','local-git','center',0,'builtin:local-git:project.overview',${literal(stamp)},${literal(stamp)})`,
        );
        await repo.seed(
          "CREATE FUNCTION workspace_http_receipt_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation_id='reject-http-receipt' THEN RAISE EXCEPTION 'controlled workspace HTTP receipt failure'; END IF; RETURN NEW; END $$",
        );
        await repo.seed(
          "CREATE TRIGGER workspace_http_receipt_reject BEFORE INSERT ON workspace_command_receipts FOR EACH ROW EXECUTE FUNCTION workspace_http_receipt_reject()",
        );
        await repo.close();
        repo = undefined;
        await fixture.start();
        live = await new LiveProbe(fixture).open();
        await live.initialized();
        await live.subscribed("workspace", [
          currentUser,
          { kind: "project", projectId: "github" },
          { kind: "project", projectId: "local-git" },
        ]);
        let layout = await visit("retained ownership", "GET", base);
        assert.deepEqual(layout, workspaceState());
        await visit("ownership HEAD", "HEAD", base);
        await visit("missing workspace", "GET", base + "-missing", {
          status: 404,
        });
        await visit(
          "foreign project",
          "GET",
          base.replace("/github/", "/other/"),
          { status: 404 },
        );
        await visit(
          "invalid stored ownership",
          "GET",
          base.replace(/workspace$/, "bad-layout"),
          { status: 500 },
        );
        if (profile !== "none") {
          await visit("anonymous read", "GET", base, {
            client: "anonymous",
            status: 401,
          });
          await visit("anonymous seed", "POST", base + "/seed", {
            client: "anonymous",
            json: { mainWindowId: "main" },
            status: 401,
          });
          await visit("CSRF required for seed", "POST", base + "/seed", {
            csrf: false,
            json: { mainWindowId: "main" },
            status: 403,
          });
        }
        if (profile === "accounts")
          await visit("another account read", "GET", base, {
            client: "other",
            status: 404,
          });
        const folder =
          "/api/projects/folder/workspace-layouts/" +
          encodeURIComponent("device/desktop 🦀");
        const seeded = await visit(
          "seed encoded device identity",
          "POST",
          folder + "/seed",
          { json: { mainWindowId: "folder-main" } },
        );
        assert.equal(seeded.id, "device/desktop 🦀");
        assert.deepEqual(seeded.windows[0].panes, []);
        await visit(
          "seed converges on retained identity",
          "POST",
          folder + "/seed",
          { json: { mainWindowId: "folder-main", focusedPaneId: "missing" } },
        );
        await visit("different main identity", "POST", folder + "/seed", {
          json: { mainWindowId: "other" },
          status: 409,
        });
        await visit(
          "missing seed project",
          "POST",
          base.replace("/github/", "/missing/") + "/seed",
          { json: { mainWindowId: "main" }, status: 404 },
        );
        await visit(
          "legacy center invariant",
          "POST",
          "/api/projects/local-git/workspace-layouts/invalid/seed",
          { json: { mainWindowId: "main" }, status: 400 },
        );
        for (const [name, url, input] of [
          [
            "unknown seed field",
            base + "/seed",
            { mainWindowId: "main", layout: {} },
          ],
          ["null command", base + "/commands", null],
          [
            "invalid command action",
            base + "/commands",
            { operationId: "invalid", action: { type: "invented" } },
          ],
          ["invalid import", base + "/import-legacy-files", {}],
        ])
          await visit(name, "POST", url, { json: input, status: 400 });
        await visit("malformed JSON", "POST", base + "/seed", {
          raw: '{"mainWindowId":',
          headers: { "content-type": "application/json" },
          status: 400,
        });
        await visit("unsupported body", "POST", base + "/seed", {
          raw: "<seed/>",
          headers: { "content-type": "application/xml" },
          status: 415,
        });
        await visit("oversized workspace request", "POST", base + "/seed", {
          json: { padding: "x".repeat(65537) },
          fetcher: streamingHttpRequest,
          status: 413,
        });
        let sequence = 0;
        const command = (action, changes = {}) => ({
          operationId: "http-" + sequence++,
          projectId: "github",
          workspaceId: "workspace",
          windowId: "main",
          attachmentGeneration: layout.windows.find((w) => w.id === "main")
            .attachmentGeneration,
          expectedRevision: layout.revision,
          action,
          ...changes,
        });
        const execute = async (name, input, options = {}) => {
          const value = await visit(name, "POST", base + "/commands", {
            json: input,
            ...options,
          });
          if ((options.status ?? 200) < 400) layout = value.layout;
          return value;
        };
        const first = command({ type: "select", tabId: "b" });
        await execute("select owns durable receipt", first);
        await execute("home advances revision", command({ type: "home" }));
        const replay = await execute(
          "replay returns current layout and old revision",
          first,
        );
        assert.equal(replay.replayed, true);
        assert.equal(replay.appliedRevision, 5);
        assert.equal(replay.layout.revision, 6);
        await execute(
          "changed receipt identity",
          { ...first, action: { type: "home" } },
          { status: 400 },
        );
        await execute(
          "stale revision",
          command({ type: "home" }, { expectedRevision: 0 }),
          { status: 409 },
        );
        await execute(
          "route scope mismatch",
          command({ type: "home" }, { workspaceId: "other" }),
          { status: 400 },
        );
        await execute(
          "attachment fences receipt replay",
          { ...first, attachmentGeneration: 0 },
          { status: 409 },
        );
        await execute(
          "replace renderer",
          command({ type: "replace-attachment", rendererId: "replacement" }),
        );
        await execute("old renderer cannot replay", first, { status: 409 });
        const canonical = command({
          type: "open",
          tab: workspaceTab("browser-view", "browser", "project.browser"),
          target: { kind: "pane", paneId: "center-a" },
        });
        await execute("authorized canonical encrypted title", canonical);
        assert.deepEqual(
          layout.windows[0].panes[0].tabs.find((t) => t.id === "browser-view")
            .titleProtection,
          label("browser"),
        );
        await execute(
          "prepare detach retains source ownership",
          command({
            type: "prepare-detach",
            transferId: "transfer",
            paneId: "center-b",
            destinationWindowId: "transfer-window",
            destinationPaneId: "center-b",
          }),
        );
        const destination = {
          windowId: "transfer-window",
          attachmentGeneration: 0,
        };
        await execute(
          "attach destination renderer",
          command(
            { type: "replace-attachment", rendererId: "destination-renderer" },
            destination,
          ),
        );
        await execute(
          "destination readiness",
          command(
            { type: "transfer-ready", transferId: "transfer" },
            destination,
          ),
        );
        await execute(
          "destination state restored",
          command(
            { type: "transfer-state-ready", transferId: "transfer" },
            destination,
          ),
        );
        await execute(
          "source commits detach",
          command({ type: "commit-transfer", transferId: "transfer" }),
        );
        assert.equal(
          layout.windows.find((w) => w.id === "transfer-window").panes[0].id,
          "center-b",
        );
        await execute(
          "prepare return",
          command(
            {
              type: "prepare-return",
              transferId: "return",
              paneId: "center-b",
              splitId: "returned-split",
            },
            destination,
          ),
        );
        await execute(
          "main ready for return",
          command({ type: "transfer-ready", transferId: "return" }),
        );
        await execute(
          "main restored return state",
          command({ type: "transfer-state-ready", transferId: "return" }),
        );
        const returned = await execute(
          "detached source commits return",
          command(
            { type: "commit-transfer", transferId: "return" },
            destination,
          ),
        );
        assert.deepEqual(
          layout.windows.find((w) => w.id === "transfer-window").panes,
          [],
        );
        assert.deepEqual(returned.emptyWindowIds, ["transfer-window"]);
        const beforeFailure = structuredClone(layout);
        await execute(
          "receipt failure is internal error",
          command({ type: "home" }, { operationId: "reject-http-receipt" }),
          { status: 500 },
        );
        assert.deepEqual(
          await visit("failed receipt retains layout", "GET", base),
          beforeFailure,
        );
        const input = {
          windowId: "cantrip-editor-import",
          paneId: "import-pane",
          views: [{ tabId: "file-view", documentId: document, mode: "edit" }],
          expectedRevision: layout.revision,
        };
        const imported = await visit(
          "import immutable legacy view",
          "POST",
          base + "/import-legacy-files",
          { json: input },
        );
        layout = imported.layout;
        await visit(
          "import receipt ignores stale revision",
          "POST",
          base + "/import-legacy-files",
          { json: { ...input, expectedRevision: 0 } },
        );
        await visit(
          "import receipt rejects changed identity",
          "POST",
          base + "/import-legacy-files",
          {
            json: { ...input, views: [{ ...input.views[0], mode: "visual" }] },
            status: 400,
          },
        );
        const retained = structuredClone(layout);
        await live.close();
        live = undefined;
        await fixture.close();
        await fixture.start();
        assert.deepEqual(
          await visit(
            "restart retains detached and imported ownership",
            "GET",
            base,
          ),
          retained,
        );
        const restarted = await execute(
          "restart retains exact command receipt",
          canonical,
        );
        assert.equal(restarted.replayed, true);
        assert.equal(restarted.appliedRevision, 8);
        await visit(
          "restart retains import receipt",
          "POST",
          base + "/import-legacy-files",
          { json: input },
        );
      } catch (error) {
        result.diagnostics = fixture.server?.diagnostics();
        throw error;
      } finally {
        await live?.close();
        await fixture.close();
        await repo?.close();
      }
    }
    for (const key of ["observations", "changes"])
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
      liveBarriers: p.runtimes[0].changes.length,
    })),
  }),
);
