// Production HTTP/job/Live services, unchanged WorkerConnection and endpoint crypto.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, copyFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { eventually } from "./full-worker.mjs";
import { password } from "./security-fixtures.mjs";
import { importEndpointCrypto } from "./chat-import-http-crypto.mjs";
import { importLeases } from "./chat-import-http-leases.mjs";
import { importRestarts } from "./chat-import-http-restart.mjs";
import { importDiscoveryEdges } from "./chat-import-http-discovery.mjs";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import {
  targetStateSql,
  localOwner,
  otherOwner,
  label,
  literal,
  json,
  stamp,
} from "./project-target-state.mjs";
import {
  importWorker,
  importWorkerState,
  sourceId,
} from "./chat-import-http-worker.mjs";
const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    profile: { type: "string" },
    report: { type: "string" },
    leases: { type: "boolean", default: false },
    lifecycle: { type: "boolean", default: false },
    discovery: { type: "boolean", default: false },
  },
});
const root = await mkdtemp(path.join(tmpdir(), "cantrip-chat-import-http-"));
process.stderr.write(
  JSON.stringify({ event: "chat-import.http.created", root }) + "\n",
);
const report = {
  suite: "chat-import-http",
  root,
  database: values.database,
  scope:
    "Production HTTP/job/Live services, unchanged WorkerConnection and actual message, attachment metadata and relay encryption. External source files and native runtime replies are controlled.",
  profiles: [],
  completeReplacement: false,
};
const projectId = "99999999-9999-4999-8999-999999999991";
const stateQuery =
  "SELECT jsonb_build_object('jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY created_at,id) FROM chat_import_jobs j),'chats',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM chats c),'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY sequence) FROM chat_messages m),'attachments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM chat_attachments a),'replicas',(SELECT jsonb_agg(to_jsonb(r) ORDER BY attachment_id,worker_id) FROM chat_attachment_replicas r),'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY chat_id) FROM chat_runtime_sessions s),'lanes',(SELECT jsonb_agg(to_jsonb(l) ORDER BY chat_id) FROM chat_execution_lanes l),'projects',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM projects p),'groups',(SELECT jsonb_agg(to_jsonb(g) ORDER BY project_id,position) FROM tab_groups g),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY project_id,tab_id) FROM tab_group_members m),'leases',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM project_branch_leases l),'terminals',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM terminals t))::text AS result";
let pg;
const endpointCrypto = new WeakMap();
function normal(f, value, key = "", started = 0) {
  if (Array.isArray(value)) return value.map((v) => normal(f, v, "", started));
  if (value && typeof value === "object") {
    const envelope = endpointCrypto.get(f)?.envelopeLabel(value);
    if (envelope) return envelope;
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normal(f, v, k, started)]),
    );
  }
  if (typeof value !== "string") return value;
  if (/(?:At|_at)$/.test(key) && /^\d{4}-/.test(value)) {
    const ms = Date.parse(value);
    assert.ok(Number.isSafeInteger(ms), key + ": " + value);
    if (ms === Date.parse(stamp)) return stamp;
    const offset = key === "lease_expires_at" ? 120000 : 0;
    assert.ok(
      ms - offset >= started && ms - offset <= Date.now() + 1000,
      key + ": actual flow clock " + value,
    );
    return "<generated-time>";
  }
  if (["tab_key", "anchor_tab_key"].includes(key) && value.startsWith("chat:"))
    return "chat:" + f.normalize(value.slice(5));
  if (f.ids.has(value)) return f.ids.get(value);
  return f.normalize(value, key);
}
function bindAttachments(f, jobId) {
  for (let n = 0; n < 3; n++) {
    const externalId = createHash("sha256")
      .update("external-attachment-" + n)
      .digest("hex");
    // Independently derive the production hash UUID; an arbitrary v5 UUID is
    // never normalized. Worker requests and every SQL foreign key must use it.
    const bytes = createHash("sha256")
      .update(jobId + "\0" + externalId)
      .digest()
      .subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 0x50;
    bytes[8] = (bytes[8] & 63) | 0x80;
    const hex = bytes.toString("hex");
    const id = [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
    assert.ok(!f.ids.has(id));
    f.ids.set(id, "<attachment:" + f.normalize(jobId) + ":" + externalId + ">");
  }
}
function bindState(f, state) {
  const name = (id) => f.normalize(id);
  const bind = (id, key) => {
    assert.match(id, /^[a-f0-9-]{36}$/);
    if (!f.ids.has(id)) {
      assert.ok(![...f.ids.values()].includes(key));
      f.ids.set(id, key);
    }
  };
  for (const row of state.sessions ?? [])
    bind(
      row.id,
      "<session:" +
        name(row.chat_id) +
        ":" +
        row.worker_id +
        ":" +
        row.worktree_id +
        ">",
    );
  for (const row of state.lanes ?? []) {
    const session = state.sessions.find((s) => s.id === row.runtime_session_id);
    assert.ok(
      session &&
        session.chat_id === row.chat_id &&
        session.worker_id === row.worker_id &&
        session.worktree_id === row.worktree_id,
      "Actual runtime/lane foreign keys",
    );
    bind(
      row.id,
      "<lane:" +
        name(row.chat_id) +
        ":" +
        row.worker_id +
        ":" +
        row.worktree_id +
        ">",
    );
  }
  for (const row of state.messages ?? []) {
    assert.equal(row.content, null);
    assert.equal(row.task_protected_content, null);
    endpointCrypto.get(f).verifyMessage({
      id: row.id,
      classification: {
        role: row.role,
        mode: row.mode,
        attachmentIds: row.attachment_ids,
      },
      protectedContent: row.protected_content,
    });
    bind(
      row.id,
      "<message:" + name(row.chat_id) + ":" + row.idempotency_key + ">",
    );
  }
  for (const row of state.attachments ?? [])
    endpointCrypto
      .get(f)
      .verify(row.protected_metadata.envelope, "attachment metadata", row.id);
  for (const row of state.groups ?? []) {
    const member = state.members.find(
      (m) => m.group_id === row.id && m.tab_key === row.anchor_tab_key,
    );
    assert.ok(member, "Actual pane membership");
    bind(row.id, "<pane:" + row.project_id + ":" + name(member.tab_id) + ">");
  }
}
function normalState(f, state, started) {
  bindState(f, state);
  const result = normal(f, state, "", started);
  for (const rows of Object.values(result))
    if (Array.isArray(rows))
      rows.sort((a, b) =>
        String(
          a.id ?? a.tab_key ?? a.attachment_id + ":" + a.worker_id,
        ).localeCompare(
          String(b.id ?? b.tab_key ?? b.attachment_id + ":" + b.worker_id),
          "en",
        ),
      );
  return result;
}
async function flow(f, result, profile) {
  const started = Date.now(),
    state = importWorkerState(),
    workers = [],
    subscribedChats = new Set(),
    reconciledStartupFrames = new Set();
  let live;
  const visit = async (name, method, url, options = {}) => {
    const observation = await f.observe(name, method, url, {
      csrf: !!f.client(options.client).csrf,
      ...options,
    });
    result.http.push({ name, ...observation });
    return f.records.get(name);
  };
  const read = async (url) => {
    const response = await fetch(f.server.origin + url, {
      headers: {
        cookie: [...f.client().cookies].map(([k, v]) => k + "=" + v).join("; "),
      },
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const waitJob = (id, expected) =>
    eventually(
      () => read("/api/chat-imports/" + id),
      (j) => assert.equal(j.state, expected, JSON.stringify(j)),
      20000,
    );
  const sqlState = async () => {
    const [query] = await f.sql([], [stateQuery]);
    return query;
  };
  const readProtectedImport = async (name, chatId) => {
    const history = await visit(name, "GET", `/api/chats/${chatId}/messages`);
    assert.equal(history.kind, "chat-encrypted");
    result.http.at(-1).body = normal(f, history, "", started);
    const raw = await sqlState();
    const messages = raw.messages.filter((row) => row.chat_id === chatId);
    const attachments = raw.attachments.filter((row) => row.chat_id === chatId);
    const ids = new Set(attachments.map((row) => row.id));
    const replicas = raw.replicas.filter((row) => ids.has(row.attachment_id));
    assert.equal(messages.length, 2);
    assert.equal(history.messages.length, messages.length);
    assert.equal(attachments.length, 3);
    assert.deepEqual(attachments.map(({ status }) => status).sort(), [
      "failed",
      "failed",
      "ready",
    ]);
    assert.equal(replicas.length, 1);
    assert.equal(replicas[0].status, "ready");
    assert.equal(replicas[0].worker_id, "beta");
    for (const [index, row] of messages.entries()) {
      const message = history.messages[index];
      assert.equal(message.id, row.id);
      assert.equal(message.sequence, row.sequence);
      assert.equal(message.content, undefined);
      assert.equal(row.content, null);
      assert.deepEqual(message.protectedContent, row.protected_content);
      const opened = await state.crypto.reopenMessage(message);
      assert.equal(
        opened[0].text,
        "Imported message 😀 \ud800 \u2028 " + index,
      );
      assert.deepEqual(
        opened
          .filter((item) => item.type === "attachment")
          .map((item) => item.attachment.id),
        message.attachmentIds,
      );
    }
    for (const row of attachments) {
      const opened = await state.crypto.reopenAttachment({
        id: row.id,
        chatId,
        sizeBytes: row.size_bytes,
        status: row.status,
        protectedMetadata: row.protected_metadata,
        createdAt: new Date(row.created_at).toISOString(),
      });
      assert.match(opened.fileName, /^imported-private-[012]\.bin$/);
    }
    return { history, messages, attachments, replicas };
  };
  const settleEvents = async (job) => {
    await eventually(
      () => live.history.filter((v) => v.type === "event"),
      (events) => {
        const index = events.findLastIndex(
          (e) =>
            e.resource === "chat-import-job" &&
            e.entityId === job.id &&
            e.revision === job.stateRevision,
        );
        assert.ok(index >= 0, "Final job publication observed");
        const resources =
          job.chatId === null
            ? ["chat-import-job", "project"]
            : [
                "chat-import-job",
                "project",
                "chat",
                ...(subscribedChats.has(job.chatId) ? ["chat-message"] : []),
              ];
        assert.deepEqual(
          events.slice(index, index + resources.length).map((e) => e.resource),
          resources,
          "Whole ordered terminal project publication",
        );
      },
    );
  };
  const workerCommands = (commands) =>
    commands.map(({ worker, command }) => {
      const copy = structuredClone(command);
      if (copy.type === "chat.relocation.hydration.begin")
        copy.transcriptSha256 = "<digest:" + f.normalize(copy.snapshotId) + ">";
      if (copy.type === "chat.relocation.hydration.chunk")
        copy.data =
          "<canonical-chunk:" +
          copy.chunkIndex +
          ":" +
          Buffer.from(copy.data, "base64").length +
          ">";
      return normal(f, { worker, command: copy }, "", started);
    });
  const restart = async (phase, job, release) => {
    const before = await sqlState();
    const row = before.jobs.find((j) => j.id === job.id);
    assert.equal(row.state, phase);
    assert.ok(row.command_id);
    const previous = f.server;
    const port = Number(new URL(previous.origin).port);
    await Promise.all(workers.map((w) => w.close()));
    const termination = new Promise((resolve) =>
      previous.child.once("close", (code, signal) => resolve({ code, signal })),
    );
    assert.equal(previous.child.kill("SIGKILL"), true);
    const killed = await termination;
    assert.deepEqual(killed, { code: null, signal: "SIGKILL" });
    await live.waitClosed();
    const history = live.history.slice();
    const diagnostics = previous.diagnostics();
    await assert.rejects(
      () => f.close(),
      /SIGKILL/,
      "The interrupted process is actually terminal",
    );
    await release();
    await f.start({ port });
    live = await new LiveProbe(f).open();
    live.history.unshift(...history);
    await live.initialized();
    await live.subscribed("restart " + phase, [
      { kind: "project", projectId },
      ...[...subscribedChats].map((chatId) => ({ kind: "chat", chatId })),
    ]);
    const blocked = await waitJob(job.id, "blocked");
    assert.deepEqual(blocked.error, {
      code: "worker-offline",
      retryable: true,
    });
    assert.equal(blocked.attempt, row.attempt + 1);
    await live.ping("startup reconciled " + phase);
    const startupFrames = live.history.slice(history.length);
    // The new epoch can settle its offline job before or after subscription.
    // Compare its actual REST baseline and all later events. Preserve every
    // startup frame as raw evidence instead of inventing a delivery guarantee
    // for a client that was not subscribed when the transition occurred.
    for (const frame of startupFrames) reconciledStartupFrames.add(frame);
    result.restarts ??= [];
    result.restarts.push({
      phase,
      killed,
      blocked: normal(f, blocked, "", started),
      before,
      diagnostics,
      startupFrames,
    });
    // Reattach the destination before the source so a recovered read never
    // races an intentionally offline destination during this controlled test.
    await workers[1].start();
    await workers[0].start();
    return before;
  };
  const finishCase = async (name, job, before, commandOffset, eventOffset) => {
    await settleEvents(job);
    const raw = await sqlState();
    const comparable = normalState(f, raw, started);
    const commands = state.commands.slice(commandOffset);
    const uploads = state.uploads
      .filter((u) => u.snapshotId === job.id)
      .map((u) => ({
        snapshotId: f.normalize(u.snapshotId),
        payload: normal(f, u.payload, "", started),
      }));
    const events = live.history
      .slice(eventOffset)
      .filter((frame) => !reconciledStartupFrames.has(frame))
      .filter((v) => v.type === "event")
      .filter(
        (e) =>
          (e.scope.kind === "project" ||
            (e.scope.kind === "chat" && e.scope.chatId === job.chatId)) &&
          ["chat-import-job", "project", "chat", "chat-message"].includes(
            e.resource,
          ),
      )
      .map((e) =>
        normal(
          f,
          {
            scope: e.scope,
            resource: e.resource,
            action: e.action,
            entityId: e.entityId,
            revision: e.revision,
            payload: e.payload,
          },
          "",
          started,
        ),
      );
    for (const snapshot of state.snapshots.values())
      if (snapshot.threadId) {
        const bytes = Buffer.concat(snapshot.chunks);
        assert.equal(
          createHash("sha256").update(bytes).digest("hex"),
          snapshot.begin.transcriptSha256,
        );
      }
    result.cases.push({
      name,
      job: normal(f, job, "", started),
      state: comparable,
      commands: workerCommands(commands),
      uploads,
      events,
      raw: {
        job,
        state: raw,
        commands,
        uploads: state.uploads.filter((u) => u.snapshotId === job.id),
      },
    });
    return raw;
  };
  const runCase = async (
    name,
    {
      mode = "success",
      expected = "succeeded",
      attachments = false,
      messages = 2,
      changes = {},
      expectedCode,
      failureMessage,
      failCommand,
      subscribeChat = false,
      intercept,
    } = {},
  ) => {
    state.mode = mode;
    state.withAttachments = attachments;
    state.messageCount = messages;
    state.failureMessage = failureMessage;
    state.failCommand = failCommand;
    let release;
    if (subscribeChat)
      state.beginBarrier = new Promise((resolve) => {
        release = resolve;
      });
    const before = await sqlState(),
      commandOffset = state.commands.length,
      eventOffset = (await live.ping("before " + name), live.history.length);
    const selection = {
      sourceKind: "chatgpt-codex",
      sourceWorkerId: "alpha",
      sourceId,
      sourceThreadId: name,
      idempotencyKey: name,
      target: { kind: "worktree", projectId, worktreeId: "github-beta-main" },
      modelId: "import-model",
      permissionProfileId: "permission",
      ...changes,
    };
    const admitted = await visit(
      name + " admission",
      "POST",
      "/api/projects/" + projectId + "/chat-imports",
      { status: 202, json: { imports: [selection] } },
    );
    assert.equal(admitted.length, 1);
    if (attachments) bindAttachments(f, admitted[0].id);
    if (intercept) await intercept(admitted[0]);
    if (subscribeChat) {
      try {
        await eventually(
          () => state.commands.slice(commandOffset),
          (commands) =>
            assert.ok(
              commands.some(
                (c) => c.command.type === "chat.relocation.hydration.begin",
              ),
            ),
        );
        const scopes = [
          { kind: "project", projectId },
          ...[...subscribedChats, admitted[0].id].map((chatId) => ({
            kind: "chat",
            chatId,
          })),
        ];
        await live.subscribed("canonical chat " + name, scopes);
        subscribedChats.add(admitted[0].id);
      } finally {
        release();
        state.beginBarrier = undefined;
      }
    }
    const job = await waitJob(admitted[0].id, expected);
    assert.equal(
      job.createdAt,
      admitted[0].createdAt,
      "Import creation time survives every phase and restart",
    );
    if (expectedCode) assert.equal(job.error.code, expectedCode);
    const raw = await finishCase(name, job, before, commandOffset, eventOffset);
    if (expected === "succeeded") {
      assert.equal(raw.chats.filter((c) => c.id === job.id).length, 1);
      assert.equal(
        raw.messages.filter((m) => m.chat_id === job.id).length,
        messages,
      );
    } else if (job.chatId === null)
      assert.deepEqual(
        raw.chats,
        before.chats,
        "Failed pre-canonical imports leave the Chat catalog unchanged",
      );
    return { job, raw, selection };
  };
  try {
    await f.start();
    if (profile === "accounts")
      await visit("register", "POST", "/api/auth/register", {
        status: 201,
        json: {
          email: "import@example.invalid",
          displayName: "Import",
          password,
        },
      });
    else if (profile === "password")
      await visit("login", "POST", "/api/auth/login", { json: { password } });
    else await visit("session", "GET", "/api/auth/session");
    const owner =
      f.records.get(
        profile === "accounts"
          ? "register"
          : profile === "password"
            ? "login"
            : "session",
      ).currentUser?.id ?? localOwner;
    state.crypto = importEndpointCrypto(owner);
    endpointCrypto.set(f, state.crypto);
    for (const id of ["alpha", "beta"])
      workers.push(
        await importWorker({
          fixture: f,
          visit,
          root: path.join(root, profile, f.kind, "workers"),
          id,
          state,
          owner,
        }),
      );
    await f.sql([
      ...targetStateSql(owner, otherOwner, { github: projectId }).filter(
        (sql) => !/^INSERT INTO workers.*VALUES\('(alpha|beta)'/.test(sql),
      ),
      "UPDATE chats SET last_used_at=" + literal(stamp),
      "INSERT INTO project_workspaces(id,owner_id,created_at,updated_at) VALUES(" +
        literal("workspace:default:" + owner) +
        "," +
        literal(owner) +
        "," +
        literal(stamp) +
        "," +
        literal(stamp) +
        ") ON CONFLICT(id) DO NOTHING",
      "INSERT INTO project_workspace_storage_profiles(workspace_id,kind,created_at,updated_at) VALUES(" +
        literal("workspace:default:" + owner) +
        ",'system'," +
        literal(stamp) +
        "," +
        literal(stamp) +
        ") ON CONFLICT(workspace_id) DO NOTHING",
      "INSERT INTO project_workspace_memberships(workspace_id,project_id,created_at) VALUES(" +
        literal("workspace:default:" + owner) +
        "," +
        literal(projectId) +
        "," +
        literal(stamp) +
        ")",
      "INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('import-provider'," +
        literal(owner) +
        ",'Provider','openai-compatible','https://model.invalid/v1')",
      "INSERT INTO model_profiles(id,owner_id,name) VALUES('import-model'," +
        literal(owner) +
        ",'Import model')",
      "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('import-route','import-model','import-provider','native-model',0,true)",
    ]);
    live = await new LiveProbe(f).open();
    await live.initialized();
    await live.subscribed("import-scopes", [{ kind: "project", projectId }]);
    await visit(
      "invalid create",
      "POST",
      "/api/projects/" + projectId + "/chat-imports",
      { status: 500, json: {} },
    );
    await visit("invalid retry", "POST", "/api/chat-imports/missing/retry", {
      status: 500,
      json: { stateRevision: 0 },
    });
    await visit(
      "missing project list",
      "GET",
      "/api/projects/missing/chat-imports",
      { status: 404 },
    );
    await visit("missing job", "GET", "/api/chat-imports/missing", {
      status: 404,
    });
    await visit(
      "cannot retry missing",
      "POST",
      "/api/chat-imports/missing/retry",
      { status: 409, json: { stateRevision: 1 } },
    );
    await visit(
      "owned empty list",
      "GET",
      "/api/projects/" + projectId + "/chat-imports",
    );
    await visit(
      "missing project before bad query",
      "GET",
      "/api/projects/missing/external-chat-history?includeArchived=invalid",
      { status: 404 },
    );
    await visit(
      "invalid archive query",
      "GET",
      "/api/projects/" +
        projectId +
        "/external-chat-history?includeArchived=invalid",
      { status: 400 },
    );
    await visit(
      "duplicate archive query",
      "GET",
      "/api/projects/" +
        projectId +
        "/external-chat-history?includeArchived=true&includeArchived=false",
      { status: 400 },
    );
    const discovery = await visit(
      "external discovery",
      "GET",
      "/api/projects/" + projectId + "/external-chat-history",
    );
    for (const worker of discovery.workers)
      for (const source of worker.sources)
        for (const thread of source.threads)
          assert.equal(
            thread.existingImport,
            null,
            "Server overwrites untrusted worker import annotations",
          );
    const success = await runCase("success");
    if (values.discovery)
      await importDiscoveryEdges({
        fixture: f,
        visit,
        state,
        workers,
        projectId,
        owner,
        imported: success.job,
        result,
      });
    await runCase("success-chat-live", { subscribeChat: true });
    await visit(
      "successful import cannot retry",
      "POST",
      "/api/chat-imports/" + success.job.id + "/retry",
      {
        status: 409,
        json: { stateRevision: success.job.stateRevision },
      },
    );
    const replay = await visit(
      "idempotent import replay",
      "POST",
      "/api/projects/" + projectId + "/chat-imports",
      {
        status: 202,
        json: { imports: [success.selection] },
      },
    );
    assert.deepEqual(replay, [success.job]);
    await visit(
      "idempotency payload conflict",
      "POST",
      "/api/projects/" + projectId + "/chat-imports",
      {
        status: 409,
        json: { imports: [{ ...success.selection, planMode: "plan" }] },
      },
    );
    if (profile === "accounts") {
      await visit("other account", "POST", "/api/auth/register", {
        status: 201,
        client: "other",
        json: {
          email: "other-import@example.invalid",
          displayName: "Other",
          password,
        },
      });
      for (const [name, url] of [
        [
          "other project history hidden",
          "/api/projects/" + projectId + "/chat-imports",
        ],
        [
          "other project discovery hidden",
          "/api/projects/" +
            projectId +
            "/external-chat-history?includeArchived=invalid",
        ],
        ["other import job hidden", "/api/chat-imports/" + success.job.id],
      ])
        await visit(name, "GET", url, { status: 404, client: "other" });
      await visit(
        "other import retry hidden",
        "POST",
        "/api/chat-imports/" + success.job.id + "/retry",
        {
          status: 409,
          client: "other",
          json: { stateRevision: success.job.stateRevision },
        },
      );
    }
    const attached = await runCase("attachment-success", {
      attachments: true,
      subscribeChat: true,
    });
    const attachedBefore = await readProtectedImport(
      "encrypted import history",
      attached.job.chatId,
    );
    if (profile === "accounts")
      await visit(
        "foreign encrypted import history",
        "GET",
        `/api/chats/${attached.job.chatId}/messages`,
        {
          client: "other",
          status: 404,
        },
      );
    await runCase("changed-source", {
      mode: "changed-identity",
      expected: "failed",
      expectedCode: "source-changed",
    });
    await runCase("invalid-transcript", {
      mode: "invalid-transcript",
      expected: "failed",
      expectedCode: "runtime-incompatible",
    });
    await runCase("protection-mismatch", {
      mode: "protect-truncated",
      expected: "failed",
      expectedCode: "worker-error",
    });
    const blocked = await runCase("read-retry", {
      mode: "read-error",
      expected: "blocked",
      expectedCode: "worker-error",
    });
    state.mode = "success";
    const commandOffset = state.commands.length,
      eventOffset = live.history.length;
    await visit(
      "retry import",
      "POST",
      "/api/chat-imports/" + blocked.job.id + "/retry",
      { json: { stateRevision: blocked.job.stateRevision } },
    );
    const retried = await waitJob(blocked.job.id, "succeeded");
    assert.equal(retried.createdAt, blocked.job.createdAt);
    await finishCase(
      "retried read",
      retried,
      blocked.raw,
      commandOffset,
      eventOffset,
    );
    let releaseRead;
    state.readBarrier = new Promise((resolve) => {
      releaseRead = resolve;
    });
    try {
      await runCase("source-disconnect", {
        intercept: async (job) => {
          await eventually(
            () => state.commands,
            (commands) =>
              assert.ok(
                commands.some(
                  (c) =>
                    c.command.type === "external.chat-history.read" &&
                    c.command.chatId === job.id,
                ),
              ),
          );
          await workers[0].close();
          const disconnected = await waitJob(job.id, "blocked");
          assert.deepEqual(disconnected.error, {
            code: "worker-offline",
            retryable: true,
          });
          assert.equal(disconnected.chatId, null);
          result.interruptions ??= [];
          result.interruptions.push({
            phase: "reading",
            blocked: normal(f, disconnected, "", started),
          });
          releaseRead();
          state.readBarrier = undefined;
          await workers[0].start();
        },
      });
    } finally {
      releaseRead();
      state.readBarrier = undefined;
    }
    let releaseHydration;
    state.hydrationBarrier = new Promise((resolve) => {
      releaseHydration = resolve;
    });
    let canonicalBeforeDisconnect;
    try {
      const recovered = await runCase("hydration-disconnect", {
        intercept: async (job) => {
          await eventually(
            () => state.commands,
            (commands) =>
              assert.ok(
                commands.some(
                  (c) =>
                    c.command.type === "chat.relocation.hydration.complete" &&
                    c.command.snapshotId === job.id,
                ),
              ),
          );
          canonicalBeforeDisconnect = (await sqlState()).messages.filter(
            (m) => m.chat_id === job.id,
          );
          assert.equal(canonicalBeforeDisconnect.length, 2);
          await workers[1].close();
          const disconnected = await waitJob(job.id, "blocked");
          assert.deepEqual(disconnected.error, {
            code: "worker-offline",
            retryable: true,
          });
          assert.equal(disconnected.chatId, job.id);
          result.interruptions.push({
            phase: "hydrating",
            blocked: normal(f, disconnected, "", started),
          });
          releaseHydration();
          state.hydrationBarrier = undefined;
          await eventually(
            () => state.snapshots.get(job.id),
            (snapshot) => assert.ok(snapshot?.threadId),
          );
          await workers[1].start();
        },
      });
      assert.deepEqual(
        recovered.raw.messages.filter((m) => m.chat_id === recovered.job.id),
        canonicalBeforeDisconnect,
        "Post-canonical reconnect preserves exact immutable encrypted messages",
      );
      assert.equal(
        state.uploads.filter((u) => u.snapshotId === recovered.job.id).length,
        1,
        "Lost acknowledgment resumes the existing managed thread without another upload",
      );
    } finally {
      releaseHydration();
      state.hydrationBarrier = undefined;
    }
    if (values.lifecycle && profile === "none")
      await importRestarts({ state, runCase, restart, result });
    if (values.leases && profile === "none")
      await importLeases({
        fixture: f,
        state,
        live,
        projectId,
        sourceId,
        visit,
        waitJob,
        sqlState,
        finishEvents: settleEvents,
        normalState: (value) => normalState(f, value, started),
        workerCommands,
        normal: (value) => normal(f, value, "", started),
        result,
      });
    const wrongDigest = await runCase("canonical-wrong-digest", {
      mode: "wrong-digest",
      expected: "failed",
      expectedCode: "source-changed",
    });
    state.mode = "success";
    const hydrationRetryCommands = state.commands.length,
      hydrationRetryEvents = live.history.length;
    await visit(
      "retry failed canonical import",
      "POST",
      "/api/chat-imports/" + wrongDigest.job.id + "/retry",
      { json: { stateRevision: wrongDigest.job.stateRevision } },
    );
    const repaired = await waitJob(wrongDigest.job.id, "succeeded");
    const repairedState = await finishCase(
      "explicit canonical retry",
      repaired,
      wrongDigest.raw,
      hydrationRetryCommands,
      hydrationRetryEvents,
    );
    assert.deepEqual(
      repairedState.messages.filter((m) => m.chat_id === repaired.id),
      wrongDigest.raw.messages.filter((m) => m.chat_id === repaired.id),
      "Explicit post-canonical retry preserves immutable history",
    );
    assert.ok(
      state.commands
        .slice(hydrationRetryCommands)
        .every(
          (c) =>
            c.command.type !== "external.chat-history.read" &&
            c.command.type !== "chat.messages.protect",
        ),
      "Post-canonical retry reuses the canonical transcript without rereading or reprotecting it",
    );
    assert.equal(
      state.uploads.filter((u) => u.snapshotId === repaired.id).length,
      1,
    );
    await runCase("canonical-no-model", {
      changes: { modelId: null },
      expected: "succeeded",
    });
    await runCase("multi-protect-batch", { messages: 103 });
    await runCase("protection-wrong-key", {
      mode: "protect-wrong-key",
      expected: "failed",
      expectedCode: "worker-error",
    });
    await runCase("invalid-attachment-reference", {
      mode: "invalid-attachment-reference",
      attachments: true,
      expected: "failed",
      expectedCode: "runtime-incompatible",
    });
    for (const mode of [
      "attachment-unavailable",
      "attachment-size-changed",
      "attachment-wrong-sequence",
      "attachment-early-eof",
      "attachment-unterminated",
      "attachment-authentication-failure",
      "attachment-unverified",
      "attachment-size-unverified",
    ]) {
      const schemaFailure = mode === "attachment-unverified";
      const failed = await runCase(mode, {
        mode,
        attachments: true,
        expected: schemaFailure ? "failed" : "blocked",
        expectedCode: schemaFailure ? "runtime-incompatible" : "worker-error",
      });
      const commands = result.cases.at(-1).raw.commands;
      assert.equal(
        commands.at(-1).command.type,
        "attachment.delete",
        "Partial or unverified uploads are deleted",
      );
      assert.equal(
        state.attachmentUploads.size,
        1,
        "Only the previously successful attachment upload remains",
      );
      assert.equal(failed.job.chatId, null);
    }
    await runCase("attachment-release-error", {
      mode: "release-error",
      attachments: true,
    });
    await runCase("canonical-wrong-sync", {
      mode: "wrong-sync-thread",
      expected: "blocked",
      expectedCode: "worker-error",
    });
    const failureClasses = [
      [
        "unsupported-runtime",
        "Outside Cantrip's tested range",
        "runtime-incompatible",
        false,
      ],
      [
        "permission-runtime",
        "Missing permission profile",
        "runtime-incompatible",
        false,
      ],
      ["project-match", "The project match changed", "project-mismatch", false],
      ["source-identity", "Source identity changed", "source-changed", false],
      [
        "missing-source",
        "External transcript not found",
        "source-not-found",
        false,
      ],
      ["timeout-retry", "External read timeout", "worker-error", true],
      [
        "unicode-error-truncation",
        "😀".repeat(1100) + "\ud800",
        "worker-error",
        true,
      ],
    ];
    for (const [
      name,
      failureMessage,
      expectedCode,
      retryable,
    ] of failureClasses) {
      const { job } = await runCase(name, {
        mode: "read-error",
        failureMessage,
        expected: retryable ? "blocked" : "failed",
        expectedCode,
      });
      assert.equal(job.error.retryable, retryable);
      assert.equal(
        Object.hasOwn(job.error, "message"),
        false,
        "Worker error text is never exposed in the public import summary",
      );
    }
    for (const compatibility of ["missing", "incompatible"]) {
      workers[1].heartbeat.codexRuntime.compatibility = compatibility;
      await workers[1].pulse();
      const { job } = await runCase("canonical-runtime-" + compatibility);
      assert.equal(job.managedThreadId, null);
    }
    workers[1].heartbeat.codexRuntime.compatibility = "compatible";
    delete workers[1].heartbeat.codexRuntime.methods["thread/read"];
    await workers[1].pulse();
    const missingMethod = await runCase("canonical-missing-method");
    assert.equal(missingMethod.job.managedThreadId, null);
    workers[1].heartbeat.codexRuntime.methods["thread/read"] = "available";
    await workers[1].pulse();
    await visit(
      "owned import history",
      "GET",
      "/api/projects/" + projectId + "/chat-imports",
    );
    state.mode = "worker-truncated-only";
    const notTruncated = await visit(
      "worker aggregate truncation ignored",
      "GET",
      "/api/projects/" + projectId + "/external-chat-history",
    );
    assert.equal(notTruncated.truncated, false);
    state.mode = "source-truncated";
    const truncated = await visit(
      "source truncation",
      "GET",
      "/api/projects/" + projectId + "/external-chat-history",
    );
    assert.equal(truncated.partial, true);
    assert.equal(truncated.truncated, true);
    state.mode = "discovery-error";
    await visit(
      "discovery error",
      "GET",
      "/api/projects/" + projectId + "/external-chat-history",
    );
    state.mode = "discovery-timeout";
    await visit(
      "discovery timeout",
      "GET",
      "/api/projects/" + projectId + "/external-chat-history",
    );
    const beforeRestart = f.server;
    const port = Number(new URL(beforeRestart.origin).port);
    await Promise.all(workers.map((worker) => worker.close()));
    await live.close();
    result.beforeRestartDiagnostics = beforeRestart.diagnostics();
    await f.close();
    await f.start({ port });
    assert.equal(f.server.origin, beforeRestart.origin);
    const attachedAfter = await readProtectedImport(
      "reopened encrypted import history",
      attached.job.chatId,
    );
    assert.deepEqual(attachedAfter, attachedBefore);
    result.endpointReopen = { before: attachedBefore, after: attachedAfter };
    result.finalRaw = await sqlState();
    assert.deepEqual(
      state.heartbeatFailures ?? [],
      [],
      "Controlled workers retain healthy HTTP heartbeats",
    );
    result.background = state.background;
    result.endpointCrypto = state.crypto.counts;
    assert.equal(result.endpointCrypto.rejectedChunks, 1);
    for (const diagnostic of [
      result.beforeRestartDiagnostics,
      f.server.diagnostics(),
    ]) {
      assert.equal(diagnostic.includes("Imported message 😀"), false);
      assert.equal(diagnostic.includes("imported-private-"), false);
    }
  } catch (error) {
    result.failure = error.stack;
    result.pendingCommands = state.commands;
    throw error;
  } finally {
    result.shutdown = [];
    for (const w of workers)
      try {
        await w.close();
        result.shutdown.push({ worker: true, clean: true });
      } catch (error) {
        result.shutdown.push({
          worker: true,
          clean: false,
          error: String(error),
        });
      }
    if (live)
      try {
        await live.close();
      } catch (error) {
        result.shutdown.push({
          live: true,
          clean: false,
          error: String(error),
        });
      }
    result.liveRaw = live?.history;
    result.diagnostics = f.server?.diagnostics();
    try {
      await f.close();
      result.shutdown.push({ server: true, clean: true });
    } catch (error) {
      result.shutdown.push({
        server: true,
        clean: false,
        error: String(error),
      });
      if (!result.failure) throw error;
    }
  }
}
try {
  const buildExecutable =
    process.env.CANTRIP_RUST_SERVER_BINARY ??
    (await buildRustExample("http-sql-fixture"));
  // Every runtime and owner subprocess in this run uses the same immutable
  // artifact even when another local check rebuilds the shared Cargo target.
  const executable = path.join(
    root,
    "cantrip-server-fixture" + (process.platform === "win32" ? ".exe" : ""),
  );
  await copyFile(buildExecutable, executable);
  const artifactDigest = createHash("sha256");
  for await (const chunk of createReadStream(executable))
    artifactDigest.update(chunk);
  report.buildExecutable = buildExecutable;
  report.executableSha256 = artifactDigest.digest("hex");
  report.executable = executable;
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
      const f = new HttpFixture({
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
          ...(url ? { DATABASE_URL: url } : {}),
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
      process.stderr.write(
        JSON.stringify({
          event: "chat-import.http.runtime-started",
          profile,
          kind,
          database: values.database,
        }) + "\n",
      );
      await flow(f, result, profile);
      process.stderr.write(
        JSON.stringify({
          event: "chat-import.http.runtime-completed",
          profile,
          kind,
          cases: result.cases.length,
          http: result.http.length,
        }) + "\n",
      );
    }
    assert.deepEqual(
      runtimes[1].http,
      runtimes[0].http,
      profile + " public HTTP",
    );
    const comparable = (r) => r.cases.map(({ raw, ...value }) => value);
    assert.deepEqual(
      comparable(runtimes[1]),
      comparable(runtimes[0]),
      profile +
        " durable jobs, worker commands, immutable bytes and Live events",
    );
    assert.deepEqual(
      runtimes[1].leases?.comparable,
      runtimes[0].leases?.comparable,
      profile + " real lease renewal and two-import concurrency",
    );
    assert.deepEqual(
      runtimes[1].restarts?.map(({ phase, killed, blocked }) => ({
        phase,
        killed,
        blocked,
      })),
      runtimes[0].restarts?.map(({ phase, killed, blocked }) => ({
        phase,
        killed,
        blocked,
      })),
      profile + " new-epoch REST reconciliation after real crashes",
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
  }),
);
