// Real project Chat creation, replay, conversation keysets and usage receipts.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { ARCHIVED_CHAT_RETENTION_MS } from "../../tests/reference-node-server/src/db/repository.ts";
import { password } from "./security-fixtures.mjs";
import { literal, json, label } from "./project-target-state.mjs";
import {
  settingsHttpFixture,
  settingsProject,
  settingsChat,
  settingsWorker,
  settingsTree,
} from "./native-settings-http-fixture.mjs";
import { eventually } from "./full-worker.mjs";
import { projectChatCreationHttpRaces } from "./project-chat-creation-races.mjs";

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-project-chat-create-"));
const id = (n) => `f9f9f9f9-9999-4999-8999-${String(n).padStart(12, "0")}`;
const active = [id(1), id(2), id(3)],
  archived = [id(10), id(11)],
  task = id(20),
  archivedTask = id(21);
const created = [id(50), id(51), id(52)],
  rolledBack = id(53),
  branch = "creation-branch";
const body = (chat, extra = {}) => ({
  id: chat,
  titleProtection: label("chat"),
  ...extra,
});
const detached = body(created[1], { attachToTabLayout: false });
const archiveBody = body(archived[1], { attachToTabLayout: false });
const report = {
  suite: "project-chat-creation-http",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
let pg, h, repository, failure;
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
      const result = { kind, observations: [], snapshotProofs: 0 };
      outputs.push(result);
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      h = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        repositoryExecutable,
        databaseMode,
        url,
        passwordHash,
        result,
        configure: () => [
          "UPDATE user_settings SET default_model_id=NULL,auto_name_chats=false,auto_name_tasks=false",
          `UPDATE chats SET position=0,created_at='2026-10-25T00:00:00Z',updated_at='2026-10-25T00:00:00Z',last_used_at='2026-10-25T00:00:00.001Z' WHERE id=${literal(settingsChat)}`,
          ...[...active, ...archived, task, archivedTask].map((chat, index) => {
            const archivedAt =
              index === 3
                ? "2026-10-26T00:00:00.000002Z"
                : index === 4 || index === 6
                  ? "2026-10-26T00:00:00.000001Z"
                  : null;
            const used =
              index < 2
                ? "2026-10-25T00:00:00.003Z"
                : "2026-10-25T00:00:00.002Z";
            return `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,experience,position,archived_at,created_at,updated_at,last_used_at) SELECT ${literal(chat)},owner_id,project_id,active_worktree_id,active_worker_id,protected_label,${literal([task, archivedTask].includes(chat) ? "task" : "agent")},${index + 1},${literal(archivedAt)},${literal(`2026-10-25T00:00:00.00000${index === 0 ? 2 : 1}Z`)},'2026-10-25T00:00:00Z',${literal(used)} FROM chats WHERE id=${literal(settingsChat)}`;
          }),
          `INSERT INTO conversation_creation_requests(chat_id,request) VALUES(${literal(archived[1])},${json({ ...archiveBody, worktreeMode: "agent-managed" })})`,
          `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state,head) VALUES(${literal(branch)},'settings-source',${literal(settingsWorker)},'Branch','/worker-owned/branch','/worker-owned/branch',false,'cantrip','ready','head-before-create')`,
          `INSERT INTO chat_messages(id,chat_id,worktree_id,role,content) VALUES(${literal(id(100))},${literal(archived[0])},${literal(settingsTree)},'user','[]')`,
        ],
      });
      const visit = h.visit,
        catalog = `/api/projects/${settingsProject}/conversations`,
        create = `/api/projects/${settingsProject}/chats`;
      h.fixture.chatArchiveExpirations.add(
        new Date(
          Date.parse("2026-10-26T00:00:00Z") + ARCHIVED_CHAT_RETENTION_MS,
        ).toISOString(),
      );
      const page = await visit(
        "active conversation keyset first",
        "GET",
        catalog + "?limit=1",
      );
      assert.equal(page.total, 4);
      assert.equal(page.items[0].id, active[0]);
      const cursor = JSON.parse(
        Buffer.from(page.nextCursor, "base64url").toString(),
      );
      assert.equal(cursor.createdAt, "2026-10-25T00:00:00.000002Z");
      const second = await visit(
        "active keyset preserves PostgreSQL microseconds",
        "GET",
        catalog + "?limit=1&cursor=" + encodeURIComponent(page.nextCursor),
      );
      assert.equal(second.items[0].id, active[1]);
      const rest = await visit(
        "active keyset remaining rows",
        "GET",
        catalog + "?limit=100&cursor=" + encodeURIComponent(second.nextCursor),
      );
      assert.deepEqual(
        rest.items.map((x) => x.id),
        [active[2], settingsChat],
      );
      assert.equal(rest.nextCursor, null);
      for (const prefix of ["!", "Ā"]) {
        const lenient = await visit(
          "Buffer cursor ignores low-byte junk " + prefix,
          "GET",
          catalog +
            "?limit=1&cursor=" +
            encodeURIComponent(prefix + page.nextCursor),
        );
        assert.equal(lenient.items[0].id, active[1]);
      }
      for (const invalid of [
        "!",
        "😀" + page.nextCursor,
        Buffer.from(JSON.stringify({ ...cursor, version: 2 })).toString(
          "base64url",
        ),
      ]) {
        assert.equal(
          (
            await visit(
              "invalid cursor " + invalid,
              "GET",
              catalog + "?cursor=" + encodeURIComponent(invalid),
              { status: 400 },
            )
          ).error,
          "Invalid conversation cursor.",
        );
      }
      const wrong = Buffer.from(
        JSON.stringify({ ...cursor, state: "archived" }),
      ).toString("base64url");
      assert.equal(
        (
          await visit(
            "cursor state scope",
            "GET",
            catalog + "?cursor=" + wrong,
            { status: 400 },
          )
        ).error,
        "Conversation cursor does not match this list.",
      );
      const archive = await visit(
        "archived conversation first",
        "GET",
        catalog + "?state=archived&limit=1",
      );
      assert.equal(archive.total, 2);
      assert.equal(archive.items[0].messageCount, 1);
      assert.equal(
        JSON.parse(Buffer.from(archive.nextCursor, "base64url").toString()).at,
        "2026-10-26T00:00:00.000002Z",
      );
      const archiveRest = await visit(
        "archived microsecond keyset",
        "GET",
        catalog +
          "?state=archived&cursor=" +
          encodeURIComponent(archive.nextCursor),
      );
      assert.deepEqual(
        archiveRest.items.map((x) => x.id),
        [archived[1]],
      );
      for (const query of [
        "?limit=0",
        "?state=active&state=archived",
        "?unknown=1",
        "?limit=NaN",
      ])
        await visit("invalid catalog query " + query, "GET", catalog + query, {
          status: 400,
        });
      await visit("HEAD conversation catalog", "HEAD", catalog);
      await visit(
        "missing project precedes invalid cursor",
        "GET",
        `/api/projects/${id(99)}/conversations?cursor=!`,
        { status: 404 },
      );

      const usage = (chat, input, name, status = 200) =>
        visit(name, "POST", `/api/chats/${chat}/usage`, {
          json: input,
          status,
        });
      const firstInput = {
        clientId: id(70),
        operationId: id(71),
        sequence: 10,
      };
      const used = await usage(
        active[2],
        firstInput,
        "first conversation usage",
      );
      assert.equal(used.applied, true);
      assert.ok(Date.parse(used.lastUsedAt) > Date.parse("2026-10-25"));
      assert.deepEqual(
        await usage(active[2], firstInput, "usage receipt exact replay"),
        used,
      );
      await usage(
        active[1],
        firstInput,
        "operation cannot change conversation",
        409,
      );
      await usage(
        active[2],
        { ...firstInput, sequence: 11 },
        "operation cannot change sequence",
        409,
      );
      const stale = await usage(
        active[1],
        { ...firstInput, operationId: id(72), sequence: 9 },
        "older sequence is not applied",
      );
      assert.equal(stale.applied, false);
      assert.equal(stale.lastUsedAt, "2026-10-25T00:00:00.003Z");
      const newer = await usage(
        active[2],
        { ...firstInput, operationId: id(73), sequence: 11 },
        "newer sequence advances recency",
      );
      assert.equal(newer.applied, true);
      assert.ok(Date.parse(newer.lastUsedAt) > Date.parse(used.lastUsedAt));
      const invalidUsage = {
        clientId: id(74),
        operationId: id(75),
        sequence: 1,
      };
      for (const chat of [task, archived[0], id(99)])
        await usage(chat, invalidUsage, "non-agent/missing usage " + chat, 404);
      await usage(
        active[0],
        { ...invalidUsage, sequence: 0 },
        "invalid usage sequence",
        400,
      );

      const attached = await visit(
        "attached Agent Chat creation",
        "POST",
        create,
        { json: body(created[0]), status: 201 },
      );
      assert.equal(attached.experience, "agent");
      assert.equal(attached.activeWorktreeId, settingsTree);
      assert.equal(attached.position, 7);
      const unplaced = await visit(
        "detached conversation creation",
        "POST",
        create,
        { json: detached, status: 201 },
      );
      const replay = await visit(
        "detached creation exact replay",
        "POST",
        create,
        { json: detached, status: 201 },
      );
      assert.deepEqual(replay, unplaced);
      await visit(
        "creation receipt compares defaulted request",
        "POST",
        create,
        { json: { ...detached, worktreeMode: "agent-managed" }, status: 201 },
      );
      await visit("creation identity conflict", "POST", create, {
        json: { ...detached, autoTitle: true },
        status: 409,
      });
      await visit("archived creation identity conflict", "POST", create, {
        json: archiveBody,
        status: 409,
      });
      const github = await visit(
        "pinned Github Agent creation",
        "POST",
        create,
        {
          json: body(created[2], {
            worktreeId: branch,
            worktreeMode: "pinned",
            githubAgentContext: {
              kind: "pull-request",
              number: 42,
              intent: "fix-checks",
              headSha: "a".repeat(40),
            },
          }),
          status: 201,
        },
      );
      assert.equal(github.activeWorktreeId, branch);
      assert.equal(github.experience, "agent");
      await visit("pane failure rolls back whole creation", "POST", create, {
        json: body(rolledBack, { paneId: "missing-pane" }),
        status: 400,
      });
      await visit(
        "missing creation project",
        "POST",
        `/api/projects/${id(99)}/chats`,
        { json: body(id(54)), status: 404 },
      );
      await visit("invalid creation title classification", "POST", create, {
        json: { ...body(id(55)), titleProtection: label("project") },
        status: 400,
      });
      await visit("ambiguous placement", "POST", create, {
        json: body(id(55), {
          worktreeId: branch,
          target: {
            kind: "worktree",
            projectId: settingsProject,
            worktreeId: branch,
          },
        }),
        status: 400,
      });
      await visit("ambiguous pane", "POST", create, {
        json: body(id(55), { paneId: "one", targetRegion: "center" }),
        status: 400,
      });
      if (profile === "accounts") {
        await visit("foreign conversation project", "GET", catalog, {
          client: "other",
          status: 404,
        });
        await visit(
          "foreign usage does not allocate receipt",
          "POST",
          `/api/chats/${active[0]}/usage`,
          { client: "other", json: invalidUsage, status: 404 },
        );
        await visit(
          "foreign creation does not replay identity",
          "POST",
          create,
          { client: "other", json: detached, status: 404 },
        );
      }
      for (const chat of created) {
        await eventually(
          async () => {
            await h.fixture.observe(
              "preparation settled " + chat,
              "GET",
              `/api/chats/${chat}/preparation`,
            );
            return h.fixture.records.get("preparation settled " + chat)
              .preparation;
          },
          (v) => assert.equal(v?.phase, "needs-model"),
          15000,
        );
      }
      await visit(
        "recency order after usage and creation",
        "GET",
        catalog + "?limit=100",
      );
      await h.close();
      repository = await repositoryFixture({
        kind,
        executable: repositoryExecutable,
        root: path.join(root, profile),
        databaseMode,
        databaseUrl: url,
      });
      const sql = `SELECT jsonb_build_object('bindings',(SELECT jsonb_agg(jsonb_build_object('id',c.id,'experience',c.experience,'github',jsonb_build_array(c.github_item_kind,c.github_item_number,c.github_agent_intent,c.github_head_sha),'runtimes',(SELECT count(*) FROM chat_runtime_sessions r WHERE r.chat_id=c.id),'lanes',(SELECT jsonb_agg(jsonb_build_object('exclusive',l.exclusive,'purpose',l.purpose,'state',l.state,'startingHead',l.starting_head)) FROM chat_execution_lanes l WHERE l.chat_id=c.id),'tasks',(SELECT count(*) FROM tasks t WHERE t.chat_id=c.id),'members',(SELECT count(*) FROM tab_group_members m WHERE m.tab_id=c.id),'receipt',(SELECT request FROM conversation_creation_requests r WHERE r.chat_id=c.id)) ORDER BY c.id) FROM chats c WHERE c.id IN (${[...created, rolledBack].map(literal).join(",")})),'layoutRevision',(SELECT tab_layout_revision FROM projects WHERE id=${literal(settingsProject)}),'clients',(SELECT jsonb_agg(jsonb_build_object('id',client_id,'sequence',sequence) ORDER BY client_id) FROM conversation_usage_clients),'receipts',(SELECT count(*) FROM conversation_usage_receipts)) result`;
      const state = await repository.request({ op: "query-json", sql });
      assert.equal(state.rejected, false, state.diagnostic);
      const snapshot = state.value;
      assert.equal(snapshot.bindings.length, 3);
      assert.equal(snapshot.layoutRevision, 2);
      for (const row of snapshot.bindings) {
        assert.equal(row.runtimes, 1);
        assert.equal(row.lanes.length, 1);
        assert.equal(row.tasks, 0);
        assert.equal(row.lanes[0].state, "suspended");
        assert.equal(row.members, row.id === created[1] ? 0 : 1);
      }
      assert.equal(
        snapshot.bindings.find((x) => x.id === created[2]).lanes[0].exclusive,
        true,
      );
      assert.equal(
        snapshot.bindings.find((x) => x.id === created[2]).lanes[0]
          .startingHead,
        "head-before-create",
      );
      assert.deepEqual(
        snapshot.bindings.find((x) => x.id === created[2]).github,
        ["pull-request", 42, "fix-checks", "a".repeat(40)],
      );
      assert.deepEqual(snapshot.clients, [{ id: id(70), sequence: 11 }]);
      assert.equal(snapshot.receipts, 3);
      result.state = h.fixture.normalize(snapshot);
      await repository.close();
      repository = undefined;
      h = undefined;
    }
    assert.deepEqual(
      outputs[1].observations,
      outputs[0].observations,
      profile + " HTTP",
    );
    assert.deepEqual(
      outputs[1].state,
      outputs[0].state,
      profile + " committed state",
    );
  }
  if (databaseMode === "postgres")
    await projectChatCreationHttpRaces({
      pg,
      root,
      executable,
      repositoryExecutable,
      passwordHash,
      report,
    });
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.diagnostics = h?.diagnostics();
  report.retainedRoot = root;
} finally {
  await repository?.close();
  await h?.close();
  await pg?.close();
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    profiles: report.profiles.map((p) => ({
      profile: p.profile,
      observations: p.outputs.map((o) => o.observations.length),
    })),
    failure: report.failure ?? null,
  }),
);
if (failure) throw failure;
