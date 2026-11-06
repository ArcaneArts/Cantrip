// Full production HTTP/job/Live runtime with unchanged WorkerConnection decoding.
// Worker operations are controlled; full worker/native runtime acceptance is separate.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { LiveProbe, currentUser } from "./live-sockets.mjs";
import { eventually } from "./full-worker.mjs";
import { password } from "./security-fixtures.mjs";
import { relocationFailures } from "./chat-relocation-http-failures.mjs";
import { relocationFaultRuntime } from "./chat-relocation-commit-proxy.mjs";
import { relocationPostcommit } from "./chat-relocation-postcommit-cases.mjs";
import { relocationRecoveryFence } from "./chat-relocation-recovery-fence.mjs";
import {
  relocationCallerShutdown,
  relocationUnsafeCancellation,
} from "./chat-relocation-http-lifetimes.mjs";
import {
  relocationRestart,
  relocationConcurrency,
} from "./chat-relocation-http-lifecycle.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import {
  targetStateSql,
  otherOwner,
  localOwner,
  literal,
  json,
  label,
  stamp,
} from "./project-target-state.mjs";
import {
  relocationWorker,
  relocationWorkerState,
  revision,
} from "./chat-relocation-http-worker.mjs";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    profile: { type: "string" },
    report: { type: "string" },
    lifecycle: { type: "boolean", default: false },
    leases: { type: "boolean", default: false },
    failures: { type: "boolean", default: false },
    caller: { type: "boolean", default: false },
    "commit-faults": { type: "boolean", default: false },
    "recovery-fence": { type: "boolean", default: false },
  },
});
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-chat-relocation-http-"),
);
process.stderr.write(
  JSON.stringify({ event: "chat-relocation.http-fixture.created", root }) +
    "\n",
);
const report = {
  root,
  database: values.database,
  scope:
    "Real HTTP, production relocation and replica job services, App Live, unchanged WorkerConnection; controlled worker operation results; not full-worker/native runtime or packaging acceptance",
  profiles: [],
  completeReplacement: false,
};
const projectId = "99999999-9999-4999-8999-999999999991";
const target = {
  kind: "worktree",
  projectId,
  worktreeId: "github-beta-main",
};
const opaque = label("chat").protectedLabel;
const attachmentId = "77777777-7777-4777-8777-000000000001";
const emptyAttachmentId = "77777777-7777-4777-8777-000000000002";
const mcpId = "77777777-7777-4777-8777-000000000003";
const standaloneId = "88888888-8888-4888-8888-000000000001";
const scratchId = "88888888-8888-4888-8888-000000000002";
const handle = (n) => "ctrr_" + Buffer.alloc(32, n).toString("base64url");
let pg;
let repositoryExecutable;
function normal(fixture, value, key = "", startedAt = 0) {
  if (Array.isArray(value))
    return value.map((item) => normal(fixture, item, "", startedAt));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        normal(fixture, v, k, startedAt),
      ]),
    );
  if (typeof value !== "string") return value;
  if (key === "idempotency_key" && value.startsWith("chat-relocation:")) {
    const match =
      /^chat-relocation:([a-f0-9-]{36}):([a-f0-9]{40}|[a-f0-9]{64})$/.exec(
        value,
      );
    assert.ok(
      match,
      "Replica operation retains relocation and revision identity",
    );
    return `chat-relocation:${fixture.normalize(match[1])}:${match[2]}`;
  }
  if (key === "payload_fingerprint" && fixture.replicaFingerprints?.has(value))
    return fixture.replicaFingerprints.get(value);
  if (key === "purpose" && value.startsWith("Relocated by job "))
    return "Relocated by job " + fixture.normalize(value.slice(17));
  if (/(?:At|_at)$/.test(key) && /^\d{4}-/.test(value)) {
    const ms = Date.parse(value);
    assert.ok(Number.isSafeInteger(ms), key + ": " + value);
    if (ms === Date.parse(stamp)) return stamp;
    if (key === "available_at" && ms === Date.parse("2099-01-01T00:00:00.000Z"))
      return "2099-01-01T00:00:00.000Z";
    const offset = key === "lease_expires_at" ? 120000 : 0;
    assert.ok(
      ms - offset >= startedAt && ms - offset <= Date.now() + 1000,
      key + ": actual operation clock bound " + value,
    );
    return "<generated-time>";
  }
  return fixture.normalize(value, key);
}
const stateQuery =
  "SELECT jsonb_build_object('chats',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM chats c),'jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY created_at,id) FROM chat_relocation_jobs j),'snapshots',(SELECT jsonb_agg(to_jsonb(s) ORDER BY created_at,id) FROM chat_relocation_snapshots s),'sessions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM chat_runtime_sessions r),'lanes',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM chat_execution_lanes l),'leases',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM project_branch_leases b),'terminals',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM terminals t),'replicas',(SELECT jsonb_agg(to_jsonb(r) ORDER BY attachment_id,worker_id) FROM chat_attachment_replicas r),'replicaJobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY created_at,id) FROM project_replica_jobs j),'sources',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM project_sources s),'worktrees',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM project_worktrees w))::text AS result";
async function flow(fixture, result, profile, faultRuntime) {
  const workers = [];
  let live;
  const startedAt = Date.now(),
    state = relocationWorkerState();
  const visit = async (name, method, url, options = {}) => {
    const observation = await fixture.observe(name, method, url, {
      csrf: !!fixture.client(options.client).csrf,
      ...options,
    });
    result.http.push({ name, ...observation });
    return fixture.records.get(name);
  };
  const read = async (url, client = "main") => {
    const response = await fetch(fixture.server.origin + url, {
      headers: {
        cookie: [...fixture.client(client).cookies]
          .map(([k, v]) => k + "=" + v)
          .join("; "),
      },
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const waitJob = (id, expected) =>
    eventually(
      () => read("/api/chat-relocations/" + id),
      (job) => assert.equal(job.state, expected, JSON.stringify(job)),
      20000,
    );
  try {
    await fixture.start();
    if (profile === "accounts")
      await visit("register", "POST", "/api/auth/register", {
        status: 201,
        json: {
          email: "relocation@example.invalid",
          displayName: "Relocation",
          password,
        },
      });
    else if (profile === "password")
      await visit("login", "POST", "/api/auth/login", { json: { password } });
    else await visit("session", "GET", "/api/auth/session");
    const owner =
      fixture.records.get(
        profile === "accounts"
          ? "register"
          : profile === "password"
            ? "login"
            : "session",
      ).currentUser?.id ?? localOwner;
    for (const id of ["alpha", "beta"])
      workers.push(
        await relocationWorker({
          fixture,
          visit,
          root: path.join(root, profile, fixture.kind, "workers"),
          id,
          state,
        }),
      );
    await fixture.sql([
      ...targetStateSql(owner, otherOwner, { github: projectId }).filter(
        (sql) => !/^INSERT INTO workers.*VALUES\('(alpha|beta)'/.test(sql),
      ),
      `INSERT INTO project_workspaces(id,owner_id,created_at,updated_at) VALUES(${literal("workspace:default:" + owner)},${literal(owner)},${literal(stamp)},${literal(stamp)}) ON CONFLICT(id) DO NOTHING`,
      `INSERT INTO project_workspace_storage_profiles(workspace_id,kind,created_at,updated_at) VALUES(${literal("workspace:default:" + owner)},'system',${literal(stamp)},${literal(stamp)}) ON CONFLICT(workspace_id) DO NOTHING`,
      `INSERT INTO project_workspace_memberships(workspace_id,project_id,created_at) VALUES(${literal("workspace:default:" + owner)},${literal(projectId)},${literal(stamp)})`,
      `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('relocation-provider',${literal(owner)},'Provider','openai-compatible','https://example.invalid/v1')`,
      `INSERT INTO model_profiles(id,owner_id,name) VALUES('relocation-model',${literal(owner)},'Model')`,
      "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('relocation-route','relocation-model','relocation-provider','native-model',0,true)",
      `UPDATE project_worktrees SET head='${revision}',branch='main' WHERE project_source_id LIKE 'github-%'`,
      `UPDATE chats SET last_used_at=${literal(stamp)}`,
      "UPDATE chats SET model_id='relocation-model',permission_profile_id='permission' WHERE id='chat'",
      "UPDATE terminals SET kind='chat-console',linked_chat_id='chat' WHERE id='terminal'",
      `INSERT INTO chat_messages(id,chat_id,worktree_id,role,mode,protected_content,attachment_ids,reasoning_adjusted,idempotency_key,created_at) VALUES('relocation-message','chat','github-alpha-main','user','default',${json(opaque)},'[]',false,'source-message',${literal(stamp)})`,
      `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,model_route_id,status,created_at,updated_at) VALUES('source-session','chat','alpha','github-alpha-main','source-thread','relocation-route','ready',${literal(stamp)},${literal(stamp)})`,
      `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,runtime_session_id,codex_thread_id,created_at,updated_at) VALUES('source-lane','chat','github-alpha-main','alpha','user',false,'Source lane','suspended','source-session','source-thread',${literal(stamp)},${literal(stamp)})`,
      `UPDATE projects SET github_repository_id=${literal(handle(1))},github_repository_full_name=${literal(handle(2))},github_repository_url=${literal(handle(3))} WHERE id=${literal(projectId)}`,
      `INSERT INTO mcp_servers(id,owner_id,project_id,worker_id,audience,name_blind_index,protected_configuration,created_at,updated_at) VALUES('77777777-7777-4777-8777-000000000004',${literal(owner)},NULL,NULL,'ide',${literal(Buffer.alloc(32, 6).toString("base64url"))},${json(opaque)},${literal(stamp)},${literal(stamp)}),(${literal(mcpId)},${literal(owner)},${literal(projectId)},'beta','ide',${literal(Buffer.alloc(32, 6).toString("base64url"))},${json(opaque)},${literal(stamp)},${literal(stamp)})`,
      `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,created_at,updated_at,last_used_at) VALUES('folder-chat',${literal(owner)},'folder','folder-alpha-main','alpha',${json(label("chat"))},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
      `INSERT INTO chats(id,owner_id,context_kind,active_worker_id,active_scratch_root_id,worktree_mode,protected_label,created_at,updated_at,last_used_at) VALUES(${literal(standaloneId)},${literal(owner)},'standalone','alpha',${literal(scratchId)},NULL,${json(label("chat"))},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
      `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,status,protected_path_handle,created_at,updated_at) VALUES(${literal(scratchId)},${literal(standaloneId)},${literal(owner)},'alpha','ready',${literal(handle(4))},${literal(stamp)},${literal(stamp)})`,
    ]);
    live = await new LiveProbe(fixture).open();
    await live.initialized();
    await live.subscribed("relocation-scopes", [
      currentUser,
      { kind: "project", projectId },
      { kind: "chat", chatId: "chat" },
    ]);
    await visit("invalid create", "POST", "/api/chats/chat/relocations", {
      status: 400,
      json: {},
    });
    await visit(
      "invalid retry",
      "POST",
      "/api/chat-relocations/missing/retry",
      { status: 400, json: { stateRevision: 0 } },
    );
    await visit("missing chat", "GET", "/api/chats/missing/relocations", {
      status: 404,
    });
    await visit("missing job", "GET", "/api/chat-relocations/missing", {
      status: 404,
    });
    await visit("empty history", "GET", "/api/chats/chat/relocations");
    await visit(
      "folder capability rejected",
      "GET",
      "/api/chats/folder-chat/relocations",
      { status: 409 },
    );
    await visit(
      "standalone rejected",
      "POST",
      `/api/chats/${standaloneId}/relocations`,
      {
        status: 409,
        json: { target, approved: true, idempotencyKey: "standalone" },
      },
    );
    await visit(
      "standalone history rejected",
      "GET",
      `/api/chats/${standaloneId}/relocations`,
      { status: 409 },
    );
    await visit(
      "standalone guard before schema",
      "POST",
      `/api/chats/${standaloneId}/relocations`,
      { status: 409, json: {} },
    );
    await fixture.sql(["UPDATE chats SET status='running' WHERE id='chat'"]);
    const waiting = await visit(
      "wait admission",
      "POST",
      "/api/chats/chat/relocations",
      {
        status: 202,
        json: { target, approved: true, idempotencyKey: "waiting" },
      },
    );
    assert.equal(waiting.state, "waiting-for-idle");
    const replay = await visit(
      "wait idempotency replay",
      "POST",
      "/api/chats/chat/relocations",
      {
        status: 202,
        json: { target, approved: true, idempotencyKey: "waiting" },
      },
    );
    assert.deepEqual(replay, waiting);
    await visit(
      "stale cancel",
      "POST",
      `/api/chat-relocations/${waiting.id}/cancel`,
      { status: 409, json: { stateRevision: waiting.stateRevision + 1 } },
    );
    await visit(
      "cancel waiting",
      "POST",
      `/api/chat-relocations/${waiting.id}/cancel`,
      { json: { stateRevision: waiting.stateRevision } },
    );
    await visit(
      "cancel replay conflicts",
      "POST",
      `/api/chat-relocations/${waiting.id}/cancel`,
      { status: 409, json: { stateRevision: waiting.stateRevision } },
    );
    if (profile === "accounts") {
      await visit("other account", "POST", "/api/auth/register", {
        status: 201,
        client: "other",
        json: {
          email: "other-relocation@example.invalid",
          displayName: "Other",
          password,
        },
      });
      await visit(
        "other owner chat hidden",
        "GET",
        "/api/chats/chat/relocations",
        { status: 404, client: "other" },
      );
      await visit(
        "other owner job hidden",
        "GET",
        `/api/chat-relocations/${waiting.id}`,
        { status: 404, client: "other" },
      );
      await visit(
        "other owner retry hidden",
        "POST",
        `/api/chat-relocations/${waiting.id}/retry`,
        { status: 404, client: "other", json: { stateRevision: 2 } },
      );
    }
    const reset = async () => {
      await fixture.sql([
        "DELETE FROM chat_relocation_jobs",
        "DELETE FROM project_replica_jobs",
        "DELETE FROM tasks WHERE chat_id='chat'",
        "DELETE FROM chat_attachment_replicas",
        "DELETE FROM chat_attachments",
        `UPDATE chat_messages SET protected_content=${json(opaque)},attachment_ids='[]',task_protected_content=NULL,task_attachment_ids='[]' WHERE chat_id='chat'`,
        "DELETE FROM project_branch_leases",
        "DELETE FROM chat_execution_lanes",
        "DELETE FROM chat_runtime_sessions WHERE id<>'source-session'",
        `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,runtime_session_id,codex_thread_id,created_at,updated_at) VALUES('source-lane','chat','github-alpha-main','alpha','user',false,'Source lane','suspended','source-session','source-thread',${literal(stamp)},${literal(stamp)})`,
        `UPDATE chat_runtime_sessions SET status='ready',updated_at=${literal(stamp)} WHERE id='source-session'`,
        `UPDATE chats SET status='idle',experience='agent',active_worker_id='alpha',active_worktree_id='github-alpha-main',placement_revision=1,updated_at=${literal(stamp)} WHERE id='chat'`,
        "UPDATE user_settings SET automatic_replica_synchronization='off'",
        "UPDATE model_routes SET enabled=true WHERE id='relocation-route'",
        "UPDATE chats SET model_id='relocation-model' WHERE id='chat'",
        "UPDATE project_worktrees SET is_primary=true WHERE id='github-beta-main'",
        `UPDATE terminals SET status='idle',active_worker_id='alpha',worktree_id='github-alpha-main',updated_at=${literal(stamp)} WHERE linked_chat_id='chat'`,
      ]);
      state.statusCounts = { alpha: 0, beta: 0 };
      state.heads = { alpha: revision, beta: revision };
      state.failCommand = null;
    };
    const priorJobs = new Map();
    for (const scenario of [
      { mode: "success", expected: "succeeded" },
      { mode: "source-dirty", expected: "failed", code: "worktree-dirty" },
      { mode: "target-dirty", expected: "failed", code: "worktree-dirty" },
      {
        mode: "target-became-dirty",
        expected: "failed",
        code: "worktree-dirty",
      },
      { mode: "wrong-digest", expected: "failed", code: "stale-attempt" },
      {
        mode: "stale-commit",
        expected: "failed",
        code: "stale-attempt",
        discard: true,
      },
      { mode: "source-cleanup-fails", expected: "succeeded" },
      {
        mode: "source-revision-changed",
        expected: "failed",
        code: "revision-diverged",
        stages: 0,
      },
      {
        mode: "target-revision-sync-off",
        expected: "failed",
        code: "revision-diverged",
        stages: 1,
      },
      {
        mode: "target-nonprimary",
        expected: "failed",
        code: "revision-diverged",
        stages: 1,
      },
      {
        mode: "model-not-selected",
        expected: "failed",
        code: "runtime-incompatible",
        stages: 3,
      },
      {
        mode: "model-route-disabled",
        expected: "blocked",
        code: "runtime-incompatible",
        retryable: true,
        stages: 3,
      },
      { mode: "replica-sync", expected: "succeeded" },
      {
        mode: "replica-sync-fails",
        expected: "blocked",
        code: "worker-error",
        retryable: true,
      },
      {
        mode: "retry-replica-sync",
        retryOf: "replica-sync-fails",
        expected: "succeeded",
      },
      {
        mode: "replica-sync-wrong-head",
        expected: "failed",
        code: "revision-diverged",
        stages: 1,
      },
      { mode: "attachments", expected: "succeeded", attachments: true },
      {
        mode: "task-attachments",
        expected: "succeeded",
        attachments: true,
        task: true,
      },
      {
        mode: "attachment-read-fails",
        expected: "blocked",
        attachments: true,
        code: "attachment-unavailable",
        retryable: true,
      },
      {
        mode: "retry-attachment-transfer",
        retryOf: "attachment-read-fails",
        expected: "succeeded",
      },
      {
        mode: "attachments-already-ready",
        expected: "succeeded",
        attachments: true,
      },
      ...[
        "size-changed",
        "wrong-sequence",
        "early-eof",
        "unterminated",
        "unverified",
      ].map((failure) => ({
        mode: "attachment-" + failure,
        expected: "blocked",
        code: "attachment-unavailable",
        retryable: true,
        attachments: true,
        stages: 2,
      })),
      {
        mode: "target-offline",
        expected: "blocked",
        code: "worker-offline",
        retryable: true,
        stages: 0,
      },
      {
        mode: "target-reconnected",
        reconnectOf: "target-offline",
        expected: "succeeded",
      },
    ]) {
      if (!scenario.retryOf && !scenario.reconnectOf) await reset();
      state.mode = scenario.mode;
      if (scenario.mode === "target-offline") workers[1].close();
      if (scenario.mode === "source-revision-changed")
        state.heads.alpha = "b".repeat(40);
      if (
        ["target-revision-sync-off", "target-nonprimary"].includes(
          scenario.mode,
        )
      )
        state.heads.beta = "b".repeat(40);
      if (scenario.mode === "target-nonprimary")
        await fixture.sql([
          "UPDATE project_worktrees SET is_primary=false WHERE id='github-beta-main'",
        ]);
      if (scenario.mode === "model-not-selected")
        await fixture.sql([
          "UPDATE chats SET model_id=NULL WHERE id='chat'",
          "UPDATE user_settings SET default_model_id=NULL",
        ]);
      if (scenario.mode === "model-route-disabled")
        await fixture.sql([
          "UPDATE model_routes SET enabled=false WHERE id='relocation-route'",
        ]);
      if (scenario.mode.startsWith("replica-sync")) {
        state.heads.beta = "b".repeat(40);
        await fixture.sql([
          "UPDATE user_settings SET automatic_replica_synchronization='fast-forward-primary'",
        ]);
      }
      if (scenario.attachments) {
        state.attachmentSizes = {
          [attachmentId]: 262151,
          [emptyAttachmentId]: 0,
        };
        await fixture.sql([
          `INSERT INTO chat_attachments(id,chat_id,worker_id,protected_metadata,size_bytes,created_at,updated_at) VALUES(${literal(attachmentId)},'chat','alpha',${json(opaque)},262151,${literal(stamp)},${literal(stamp)}),(${literal(emptyAttachmentId)},'chat','alpha',${json(opaque)},0,${literal(stamp)},${literal(stamp)})`,
          `INSERT INTO chat_attachment_replicas(attachment_id,worker_id,status,created_at,updated_at,verified_at) VALUES(${literal(attachmentId)},'alpha','ready',${literal(stamp)},${literal(stamp)},${literal(stamp)}),(${literal(emptyAttachmentId)},'alpha','ready',${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
          ...(scenario.task
            ? [
                "UPDATE chats SET experience='task' WHERE id='chat'",
                `UPDATE chat_messages SET protected_content=NULL,attachment_ids='[]',task_protected_content=${json(opaque)},task_attachment_ids=${json([attachmentId])} WHERE chat_id='chat'`,
                `INSERT INTO tasks(chat_id,protected_content,draft_attachment_ids,created_at,updated_at) VALUES('chat',${json(opaque)},${json([attachmentId, emptyAttachmentId])},${literal(stamp)},${literal(stamp)})`,
              ]
            : [
                `UPDATE chat_messages SET attachment_ids=${json([attachmentId, emptyAttachmentId])} WHERE chat_id='chat'`,
              ]),
        ]);
        if (scenario.mode === "attachments-already-ready")
          await fixture.sql([
            `INSERT INTO chat_attachment_replicas(attachment_id,worker_id,status,created_at,updated_at,verified_at) VALUES(${literal(attachmentId)},'beta','ready',${literal(stamp)},${literal(stamp)},${literal(stamp)}),(${literal(emptyAttachmentId)},'beta','ready',${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
          ]);
      }
      const before = live.history.length,
        commandOffset = state.commands.length,
        uploadOffset = state.uploads.length;
      const retryBase = scenario.retryOf
        ? priorJobs.get(scenario.retryOf)
        : null;
      const reconnectBase = scenario.reconnectOf
        ? priorJobs.get(scenario.reconnectOf)
        : null;
      if (scenario.retryOf) assert.ok(retryBase);
      if (scenario.reconnectOf) {
        assert.ok(reconnectBase);
        await workers[1].start();
      }
      const job =
        reconnectBase ??
        (retryBase
          ? await visit(
              scenario.mode + " retry",
              "POST",
              `/api/chat-relocations/${retryBase.id}/retry`,
              { json: { stateRevision: retryBase.stateRevision } },
            )
          : await visit(
              scenario.mode + " admit",
              "POST",
              "/api/chats/chat/relocations",
              {
                status: 202,
                json: { target, approved: true, idempotencyKey: scenario.mode },
              },
            ));
      const settled = await waitJob(job.id, scenario.expected);
      assert.equal(settled.attempt, retryBase || reconnectBase ? 2 : 1);
      priorJobs.set(scenario.mode, settled);
      if (scenario.code)
        assert.deepEqual(settled.error, {
          code: scenario.code,
          retryable: scenario.retryable ?? false,
        });
      await visit(
        scenario.mode + " settled",
        "GET",
        `/api/chat-relocations/${job.id}`,
      );
      await live.message(
        (event) =>
          event.type === "event" &&
          event.resource === "chat-relocation-job" &&
          event.entityId === job.id &&
          event.revision === settled.stateRevision,
      );
      if (scenario.expected === "succeeded" || scenario.discard)
        await eventually(
          () => state.commands.slice(commandOffset),
          (commands) =>
            assert.ok(
              commands.some(
                (call) =>
                  call.command.type === "chat.relocation.thread.release" &&
                  call.command.discard === !!scenario.discard,
              ),
            ),
        );
      await live.ping(scenario.mode + " barrier");
      const commands = state.commands.slice(commandOffset);
      if (scenario.mode === "attachments-already-ready")
        assert.equal(
          commands.filter((call) => call.command.type.startsWith("attachment."))
            .length,
          0,
        );
      if (scenario.expected === "succeeded") {
        assert.equal(settled.progress.percent, 100);
        assert.ok(
          commands.some(
            (call) =>
              call.command.type === "chat.relocation.thread.release" &&
              call.worker === "alpha" &&
              call.command.discard === false,
          ),
        );
        const begin = commands.find(
          (call) => call.command.type === "chat.relocation.hydration.begin",
        ).command;
        assert.deepEqual(
          begin.mcpServers.map((mcp) => mcp.id),
          [mcpId],
        );
        assert.deepEqual(begin.mcpServers[0].protectedConfiguration, opaque);
      }
      if (scenario.discard)
        assert.equal(
          commands.filter(
            (call) =>
              call.command.type === "chat.relocation.thread.release" &&
              call.command.discard === true,
          ).length,
          1,
        );
      // The first two status calls are concurrent across different workers.
      if (
        commands.length >= 2 &&
        commands[0].command.type === "worktree.status" &&
        commands[1].command.type === "worktree.status"
      ) {
        const first = commands
          .splice(0, 2)
          .sort((a, b) => a.worker.localeCompare(b.worker));
        commands.unshift(...first);
      }
      const [snapshot] = await fixture.sql([], [stateQuery]);
      fixture.replicaFingerprints ??= new Map();
      for (const replica of snapshot.replicaJobs ?? []) {
        assert.equal(replica.kind, "synchronize");
        assert.equal(
          replica.idempotency_key,
          `chat-relocation:${job.id}:${revision}`,
        );
        const payload = {
          kind: "synchronize",
          projectId,
          projectReplicaId: "github-beta",
          repository: handle(2),
          expectedRevision: revision,
          idempotencyKey: replica.idempotency_key,
          policy: "fast-forward-primary",
        };
        const expected = createHash("sha256")
          .update(JSON.stringify(payload))
          .digest("hex");
        assert.equal(
          replica.payload_fingerprint,
          expected,
          "Exact ordered replica idempotency hash",
        );
        fixture.replicaFingerprints.set(
          expected,
          `<verified-replica-fingerprint:${fixture.normalize(job.id)}>`,
        );
      }
      const events = live.history
        .slice(before)
        .filter(
          (frame) =>
            frame.type === "event" &&
            ["chat-relocation-job", "chat"].includes(frame.resource),
        )
        .map(({ resource, scope, entityId, revision, action, payload }) => ({
          resource,
          scope,
          entityId,
          revision,
          action,
          payload,
        }));
      const jobEvents = events.filter(
        (event) => event.resource === "chat-relocation-job",
      );
      assert.deepEqual(
        jobEvents.map((event) => event.revision),
        reconnectBase
          ? [3, 4, 5, 6, 7].map(
              (revision) => revision + reconnectBase.stateRevision,
            )
          : retryBase
            ? [1, 3, 4, 5, 6, 7].map(
                (revision) => revision + retryBase.stateRevision,
              )
            : scenario.stages !== undefined
              ? [
                  1,
                  ...Array.from(
                    { length: scenario.stages + 1 },
                    (_, i) => i + 3,
                  ),
                ]
              : scenario.expected === "succeeded" ||
                  scenario.mode === "stale-commit"
                ? [1, 3, 4, 5, 6, 7]
                : scenario.mode === "target-became-dirty"
                  ? [1, 3, 4]
                  : scenario.mode === "wrong-digest"
                    ? [1, 3, 4, 5, 6]
                    : scenario.mode === "replica-sync-fails"
                      ? [1, 3, 4]
                      : scenario.mode === "attachment-read-fails"
                        ? [1, 3, 4, 5]
                        : [1, 3],
      );
      if (scenario.expected === "succeeded")
        assert.equal(
          snapshot.chats.find((chat) => chat.id === "chat").active_worker_id,
          "beta",
        );
      else
        assert.equal(
          snapshot.chats.find((chat) => chat.id === "chat").active_worker_id,
          "alpha",
        );
      let comparedEvents = events;
      let admissionCatalog;
      if (scenario.mode === "target-offline") {
        // Captured Source PGlite and PostgreSQL traces prove both orders: the
        // independent HTTP onResponse callback can run before or after the
        // immediate offline failure. Keep each job/project pair exact, and
        // verify exactly one catalog callback between those complete pairs.
        assert.equal(events.length, 5);
        const index = events.findIndex(
          (event) => event.scope.kind === "current-user",
        );
        assert.ok(index === 2 || index === 4);
        admissionCatalog = events[index];
        assert.deepEqual(admissionCatalog, {
          resource: "chat",
          scope: currentUser,
          entityId: "chat",
          revision: null,
          action: "invalidated",
          payload: null,
        });
        result.concurrentEventTraces ??= [];
        result.concurrentEventTraces.push({
          name: scenario.mode,
          events: normal(fixture, events, "", startedAt),
        });
        comparedEvents = events.filter((_, position) => position !== index);
      }
      result.cases.push({
        name: scenario.mode,
        job: normal(fixture, settled, "", startedAt),
        commands: normal(fixture, commands, "", startedAt),
        uploads: normal(
          fixture,
          state.uploads.slice(uploadOffset),
          "",
          startedAt,
        ),
        events: normal(fixture, comparedEvents, "", startedAt),
        ...(admissionCatalog
          ? {
              admissionCatalog: normal(
                fixture,
                admissionCatalog,
                "",
                startedAt,
              ),
            }
          : {}),
        snapshot: normal(fixture, snapshot, "", startedAt),
      });
    }
    if (values["recovery-fence"])
      result.recoveryFence = await relocationRecoveryFence({
        fixture,
        state,
        live,
        reset,
        visit,
        read,
        waitJob,
        target,
        stateQuery,
        normal,
        startedAt,
        result,
        root,
        profile,
        repositoryExecutable,
      });
    if (values["commit-faults"])
      result.commitFaults = await relocationPostcommit({
        fixture,
        state,
        live,
        reset,
        visit,
        read,
        target,
        stateQuery,
        normal,
        startedAt,
        result,
        faultRuntime,
      });
    if (values.failures)
      result.boundaries = await relocationFailures({
        fixture,
        state,
        live,
        reset,
        visit,
        read,
        waitJob,
        owner,
        projectId,
        target,
        stateQuery,
        normal,
        startedAt,
      });
    if (values.leases)
      result.concurrency = await relocationConcurrency({
        fixture,
        state,
        live,
        reset,
        visit,
        waitJob,
        owner,
        projectId,
        target,
        opaque,
        stateQuery,
        normal,
        startedAt,
      });
    if (values.lifecycle)
      result.lifecycle = await relocationRestart({
        fixture,
        workers,
        state,
        live,
        setLive: (next) => {
          live = next;
        },
        reset,
        visit,
        read,
        waitJob,
        projectId,
        target,
        opaque,
        stateQuery,
        normal,
        startedAt,
        result,
      });
    if (values.caller)
      result.unsafeCancellation = await relocationUnsafeCancellation({
        fixture,
        state,
        live,
        reset,
        visit,
        read,
        waitJob,
        target,
        stateQuery,
        normal,
        startedAt,
      });
    if (values.caller)
      result.callerShutdown = await relocationCallerShutdown({
        fixture,
        live,
        reset,
        target,
        stateQuery,
        normal,
        startedAt,
        result,
      });
    result.background = state.background;
  } catch (error) {
    result.failure = error.stack;
    result.rawCommands = state.commands;
    result.rawUploads = state.uploads;
    try {
      result.failureState = (await fixture.sql([], [stateQuery]))[0];
    } catch (queryError) {
      result.failureQuery = queryError.stack;
    }
    throw error;
  } finally {
    for (const worker of workers) worker.close();
    const shutdown = [];
    if (live)
      try {
        await live.close();
        shutdown.push({ kind: "live", status: "fulfilled" });
      } catch (error) {
        shutdown.push({ kind: "live", status: "rejected", error: error.stack });
      }
    result.diagnostics = fixture.server?.diagnostics();
    try {
      await fixture.close();
      shutdown.push({ kind: "server", status: "fulfilled" });
    } catch (error) {
      shutdown.push({ kind: "server", status: "rejected", error: error.stack });
    }
    result.shutdown = shutdown;
    if (
      !result.failure &&
      shutdown.some((result) => result.status === "rejected")
    )
      throw new Error("Fixture shutdown failed: " + JSON.stringify(shutdown));
  }
}
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ??
    (await buildRustExample("http-sql-fixture"));
  report.executable = executable;
  if (values["recovery-fence"])
    repositoryExecutable = await buildRustExample("project-repository-fixture");
  const passwordHash = await hashPassword(password);
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of values.profile
    ? [values.profile]
    : ["none", "password", "accounts"]) {
    const runtimes = [];
    report.profiles.push({ profile, runtimes });
    for (const kind of ["node", "rust"]) {
      const url =
        pg && (kind === "node" || values.database === "postgres")
          ? await pg.database()
          : undefined;
      const faultRuntime = values["commit-faults"]
        ? await relocationFaultRuntime(url, kind, profile)
        : undefined;
      const fixture = new HttpFixture({
        kind,
        executable,
        root,
        name: profile,
        databaseMode: values.database,
        liveSqlFixture: true,
        environment: {
          CANTRIP_AUTH_MODE: profile,
          CANTRIP_FIXTURE_LOGGING: "true",
          CANTRIP_REGISTRATION_ENABLED: "true",
          ...(profile === "password"
            ? { CANTRIP_PASSWORD_HASH: passwordHash }
            : {}),
          ...(url ? { DATABASE_URL: faultRuntime?.url ?? url } : {}),
          ...(kind === "rust" && values.database === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      });
      const result = { kind, http: [], cases: [] };
      runtimes.push(result);
      try {
        await flow(fixture, result, profile, faultRuntime);
      } finally {
        await faultRuntime?.close();
      }
    }
    assert.deepEqual(runtimes[1].http, runtimes[0].http, profile + " HTTP");
    assert.deepEqual(
      runtimes[1].cases,
      runtimes[0].cases,
      profile + " jobs, commands, opaque bytes, Live and durable state",
    );
    assert.deepEqual(
      runtimes[1].lifecycle,
      runtimes[0].lifecycle,
      profile + " real service restart and refreshed snapshot",
    );
    assert.deepEqual(
      runtimes[1].concurrency,
      runtimes[0].concurrency,
      profile + " real concurrency and lease timer",
    );
    assert.deepEqual(
      runtimes[1].boundaries,
      runtimes[0].boundaries,
      profile +
        " cancellation, actual commit rollback, target compensation and retry",
    );
    assert.deepEqual(
      runtimes[1].callerShutdown,
      runtimes[0].callerShutdown,
      profile + " disconnected admission retained through actual shutdown",
    );
    assert.deepEqual(
      runtimes[1].unsafeCancellation,
      runtimes[0].unsafeCancellation,
      profile + " cancellation fence during actual placement commit",
    );
    assert.deepEqual(
      runtimes[1].commitFaults,
      runtimes[0].commitFaults,
      profile + " actual lost commit acknowledgement and denied recovery read",
    );
    for (const runtime of runtimes)
      for (const scenario of runtime.commitFaults ?? [])
        assert.equal(
          scenario.targetPreserved,
          true,
          `${runtime.kind} ${scenario.name}: committed target runtime must never be discarded`,
        );
    assert.deepEqual(
      runtimes[1].recoveryFence,
      runtimes[0].recoveryFence,
      profile + " actual expired-owner fencing and target reuse",
    );
    for (const runtime of runtimes)
      for (const scenario of runtime.recoveryFence ?? [])
        assert.equal(
          scenario.targetPreserved,
          true,
          `${runtime.kind} ${scenario.phase}: expired owner must not discard the target reused by the current attempt`,
        );
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
    cases: report.profiles.reduce(
      (count, p) => count + p.runtimes.reduce((n, r) => n + r.cases.length, 0),
      0,
    ),
  }),
);
