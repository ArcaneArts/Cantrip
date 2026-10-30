// Real HTTP/authentication, stored layouts, legacy aliases and ordered Live.
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
import {
  completedResponse,
  observeResponseCompletion,
} from "./response-observations.mjs";
import {
  targetStateSql,
  localOwner,
  otherOwner,
  literal,
  json,
  label,
  stamp,
} from "./project-target-state.mjs";
import { password } from "./security-fixtures.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-pane-http-"));
const report = {
  suite: "actual-pane-http",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
const base = "/api/projects/github",
  panes = base + "/panes",
  groups = base + "/tab-groups";
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
        responseObservations: true,
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
      const result = {
        kind,
        observations: [],
        changes: [],
        completionTiming: [],
      };
      runtimes.push(result);
      let repo,
        live,
        revision = 8;
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
          if (kind === "node") {
            result.completionTiming.push({
              name,
              eventsAtFirstPong: events().length - before,
              completionObservedAtFirstPong: Boolean(
                completedResponse(fixture, name),
              ),
            });
            await observeResponseCompletion(fixture, name);
            // Publications enqueue synchronously in the actual final hook's
            // predecessors. This pong follows those writes on the same WS.
            await live.ping(name + " response completed");
          }
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
          const resources =
            !["GET", "HEAD", "OPTIONS"].includes(method) &&
            observed.status < 400 &&
            /^\/api\/projects\/github\/(?:panes|tab-groups)(?:\/|$)/u.test(url)
              ? ["project", "project-tab-layout"]
              : [];
          assert.deepEqual(
            changes,
            resources.map((resource) => ({
              resource,
              scope: { kind: "project", projectId: "github" },
              entityId: "github",
              revision: null,
              payload: null,
              action: "invalidated",
            })),
            name + " exact response-completion Live events",
          );
          result.changes.push({ name, events: changes });
        }
        return fixture.records.get(name);
      };
      const change = async (name, suffix, input, options = {}) => {
        const value = await visit(
          name,
          options.method ?? "PATCH",
          base + suffix,
          {
            json:
              suffix === "/surface-launchers" ||
              suffix.startsWith("/builtin-surfaces/")
                ? input
                : { revision, ...input },
            ...options,
          },
        );
        if ((options.status ?? 200) < 400)
          revision = value?.revision ?? value?.layout?.revision ?? revision;
        return value;
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
                email: `pane-${client}@example.invalid`,
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
          `INSERT INTO project_builtin_surface_states(project_id,definition_id,created_at,updated_at) VALUES('github','project.tasks',${literal(stamp)},${literal(stamp)})`,
        );
        await repo.seed(
          `INSERT INTO tab_groups(id,project_id,region,position,anchor_tab_key,protected_label,created_at,updated_at) VALUES('center','github','center',0,'terminal:terminal',${json(label("tab-group"))},${literal(stamp)},${literal(stamp)}),('second','github','center',1,'builtin:github:project.tasks',NULL,${literal(stamp)},${literal(stamp)}),('right','github','right',0,'browser:browser',NULL,${literal(stamp)},${literal(stamp)}),('invalid','local-git','center',0,'missing',NULL,${literal(stamp)},${literal(stamp)})`,
        );
        await repo.seed(
          `INSERT INTO tab_group_members(tab_key,group_id,project_id,tab_kind,tab_id,position,created_at,updated_at) VALUES('terminal:terminal','center','github','terminal','terminal',0,${literal(stamp)},${literal(stamp)}),('chat:chat','center','github','chat','chat',1,${literal(stamp)},${literal(stamp)}),('builtin:github:project.tasks','second','github','builtin','project.tasks',0,${literal(stamp)},${literal(stamp)}),('browser:browser','right','github','browser','browser',0,${literal(stamp)},${literal(stamp)})`,
        );
        await repo.seed(
          `UPDATE projects SET tab_layout_revision=8,center_layout_root=${json({ kind: "split", id: "split", direction: "horizontal", fraction: 0.5, first: { kind: "pane", paneId: "center" }, second: { kind: "pane", paneId: "second" } })} WHERE id='github'`,
        );
        await repo.close();
        repo = undefined;
        await fixture.start();
        live = await new LiveProbe(fixture).open();
        await live.initialized();
        await live.subscribed("pane-layouts", [
          currentUser,
          { kind: "project", projectId: "github" },
          { kind: "project", projectId: "local-git" },
        ]);
        await visit("pane layout", "GET", panes);
        await visit("legacy layout", "GET", groups);
        await visit("pane HEAD", "HEAD", panes);
        await visit("legacy HEAD", "HEAD", groups);
        const launchers = await visit(
          "launcher defaults",
          "GET",
          base + "/surface-launchers",
        );
        assert.ok(launchers.length > 20);
        for (const route of ["/panes", "/tab-groups"]) {
          await visit(
            "missing " + route,
            "GET",
            "/api/projects/missing" + route,
            { status: 404 },
          );
          await visit(
            "foreign " + route,
            "GET",
            "/api/projects/other" + route,
            { status: 404 },
          );
          await visit(
            "invariant " + route,
            "GET",
            "/api/projects/local-git" + route,
            { status: 409 },
          );
        }
        await visit(
          "empty project layout",
          "GET",
          "/api/projects/folder/panes",
        );
        if (profile !== "none") {
          await visit("anonymous pane read", "GET", panes, {
            client: "anonymous",
            status: 401,
          });
          await visit("anonymous pane mutation", "PATCH", panes + "/order", {
            client: "anonymous",
            json: { revision, paneIds: ["center", "second"], region: "center" },
            status: 401,
          });
          await visit(
            "pane mutation requires CSRF",
            "PATCH",
            panes + "/order",
            {
              csrf: false,
              json: {
                revision,
                paneIds: ["center", "second"],
                region: "center",
              },
              status: 403,
            },
          );
        }
        if (profile === "accounts")
          await visit("other account pane read", "GET", panes, {
            client: "other",
            status: 404,
          });
        const invalidRoutes = [
          ...[
            "/panes/order",
            "/panes/center",
            "/panes/center/members/order",
            "/panes/member",
            "/panes/member/split",
            "/panes/splits/split",
            "/panes/member/presentation",
            "/tab-groups/order",
            "/tab-groups/center",
            "/tab-groups/center/members/order",
            "/tab-groups/member",
            "/surface-launchers",
            "/builtin-surfaces/not-a-definition/worktree",
          ].map((suffix) => ["PATCH", suffix]),
          ...[
            "/panes/member/open",
            "/panes/member/close",
            "/tab-groups/member/open",
            "/tab-groups/member/close",
          ].map((suffix) => ["POST", suffix]),
        ];
        for (const [method, suffix] of invalidRoutes)
          await visit("invalid body " + suffix, method, base + suffix, {
            json: {},
            status: 400,
          });
        await visit("malformed JSON", "PATCH", panes + "/center", {
          raw: "{",
          headers: { "content-type": "application/json" },
          status: 400,
        });
        await visit("oversized pane body", "PATCH", panes + "/center", {
          raw: JSON.stringify("x".repeat(65537)),
          headers: { "content-type": "application/json" },
          status: 413,
        });
        await change(
          "duplicate pane ids",
          "/panes/order",
          { region: "center", paneIds: ["center", "center"] },
          { status: 400 },
        );
        await change(
          "stale pane revision",
          "/panes/center",
          { revision: 0, titleProtection: label("tab-group") },
          { status: 409 },
        );
        await change(
          "single tab title invariant",
          "/panes/second",
          { titleProtection: label("tab-group") },
          { status: 400 },
        );
        await change("rename pane", "/panes/center", {
          titleProtection: label("tab-group"),
        });
        await change("reorder center leaves", "/panes/order", {
          region: "center",
          paneIds: ["second", "center"],
          unknown: "stripped",
        });
        await change("reorder legacy groups", "/tab-groups/order", {
          groupIds: ["center", "right", "second"],
        });
        await change("reorder pane members", "/panes/center/members/order", {
          tabKeys: ["chat:chat", "terminal:terminal"],
        });
        await change(
          "legacy member ordering",
          "/tab-groups/center/members/order",
          { tabKeys: ["terminal:terminal", "chat:chat"] },
        );
        await change("legacy move same pane", "/tab-groups/member", {
          tabKey: "chat:chat",
          targetGroupId: "center",
          targetMemberPosition: 0,
        });
        const split = await change(
          "split pane uses default fraction",
          "/panes/member/split",
          { tabKey: "chat:chat", targetPaneId: "second", edge: "bottom" },
        );
        const splitId = split.centerRoot.second.id;
        assert.ok(splitId);
        await change("resize generated split", "/panes/splits/" + splitId, {
          fraction: 0.63,
        });
        await change(
          "move tab from final center pane to dock",
          "/panes/member",
          {
            tabKey: "chat:chat",
            targetPaneId: "right",
            targetMemberPosition: 0,
          },
        );
        await change("dock presentation", "/panes/member/presentation", {
          tabKey: "chat:chat",
          preferredMode: "full",
          splitFraction: 0.43,
          restoreFraction: 0.57,
        });
        await change("legacy rename dock group", "/tab-groups/right", {
          titleProtection: label("tab-group"),
        });
        await change("move grouped browser to bottom dock", "/panes/member", {
          tabKey: "browser:browser",
          targetPaneId: null,
          targetRegion: "bottom",
          targetMemberPosition: 0,
        });
        const open = {
          surfaceRef: { kind: "builtin", definitionId: "github.issues" },
          targetPaneId: "center",
        };
        await change("open built-in surface", "/panes/member/open", open, {
          method: "POST",
        });
        await change(
          "focused surface ignores stale revision",
          "/tab-groups/member/open",
          { ...open, revision: 0 },
          { method: "POST" },
        );
        await change(
          "close legacy surface",
          "/tab-groups/member/close",
          { viewId: "builtin:github:github.issues" },
          { method: "POST" },
        );
        await change(
          "already closed surface still invalidates",
          "/panes/member/close",
          { revision: 0, viewId: "builtin:github:github.issues" },
          { method: "POST" },
        );
        await change("pin built-in launcher", "/surface-launchers", {
          definitionId: "git.history",
          location: "project-navigator",
          pinned: true,
        });
        await change(
          "bind built-in worktree",
          "/builtin-surfaces/git.history/worktree",
          { worktreeId: "github-alpha-main" },
        );
        await change(
          "built-in rejects unavailable worktree",
          "/builtin-surfaces/git.history/worktree",
          { worktreeId: "missing" },
          { status: 404 },
        );
        await change(
          "tasks rejects worktree",
          "/builtin-surfaces/project.tasks/worktree",
          { worktreeId: "github-alpha-main" },
          { status: 400 },
        );
        await visit(
          "launcher preferences retained",
          "GET",
          base + "/surface-launchers",
        );
        await visit("final legacy layout", "GET", groups);
        const retained = await visit("before restart layout", "GET", panes);
        await live.close();
        live = undefined;
        await fixture.close();
        await fixture.start();
        assert.deepEqual(
          await visit("restart retains pane topology", "GET", panes),
          retained,
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
      runtimes: p.runtimes.map((r) => ({
        kind: r.kind,
        observations: r.observations.length,
        liveBarriers: r.changes.length,
      })),
    })),
  }),
);
