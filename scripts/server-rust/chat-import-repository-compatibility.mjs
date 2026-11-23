// Paired real SQL repositories; protection replies are controlled, not cryptographic acceptance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { externalChatTranscriptSchema } from "../../packages/protocol/dist/external-chat-imports.js";
import { chatImportAttachmentId } from "../../tests/reference-node-server/src/db/chat-import-jobs.ts";
import { protectedAttachmentMetadataFixture } from "../../tests/reference-node-server/test/protected-attachment-fixture.ts";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import {
  targetStateSql,
  localOwner as owner,
  otherOwner as foreign,
  label,
  literal,
  json,
  stamp,
} from "./project-target-state.mjs";
const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    report: { type: "string" },
  },
});
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-chat-import-repository-"),
);
process.stderr.write(
  JSON.stringify({ event: "chat-import.repository.created", root }) + "\n",
);
const report = {
  root,
  databaseMode: values.database,
  scope:
    "Actual Node/Rust SQL repository outcomes, canonical protection requests, durable state and process reopen. Controlled protection replies; not full worker, HTTP, crypto, platform or complete replacement acceptance.",
  completeReplacement: false,
  cases: [],
  snapshots: [],
};
const pair = [],
  launches = [],
  aliases = [new Map(), new Map()],
  windows = [[], []],
  writes = [new Map(), new Map()],
  timeCache = [new Map(), new Map()];
const known = new Set([Date.parse(stamp)]),
  readOnly = new Set([
    "query-json",
    "chat-import-get",
    "chat-import-list",
    "chat-import-references",
    "chat-import-read",
    "chat-import-hydration",
    "chat-import-attachment-id",
  ]);
let pg;
function bindStateIdentities(state, index) {
  const bind = (id, key) => {
    assert.match(id, /^[a-f0-9-]{36}$/);
    if (!aliases[index].has(id)) {
      assert.ok(
        ![...aliases[index].values()].includes(key),
        "Unique durable identity " + key,
      );
      aliases[index].set(id, key);
    }
  };
  const chat = (id) => {
    assert.ok(
      state.chats.some((c) => c.id === id),
      "Actual durable Chat foreign key",
    );
    assert.ok(
      aliases[index].has(id),
      "Chat identity was observed at admission",
    );
    return aliases[index].get(id);
  };
  for (const session of state.sessions ?? []) {
    assert.notEqual(session.id, session.chat_id);
    bind(
      session.id,
      "<session:" +
        chat(session.chat_id) +
        ":" +
        session.worker_id +
        ":" +
        session.worktree_id +
        ">",
    );
  }
  for (const lane of state.lanes ?? []) {
    const session = state.sessions.find(
      (s) => s.id === lane.runtime_session_id,
    );
    assert.ok(
      session &&
        session.chat_id === lane.chat_id &&
        session.worktree_id === lane.worktree_id &&
        session.worker_id === lane.worker_id,
      "Lane points to its own persisted runtime session",
    );
    bind(
      lane.id,
      "<lane:" +
        chat(lane.chat_id) +
        ":" +
        lane.worker_id +
        ":" +
        lane.worktree_id +
        ">",
    );
  }
  for (const group of state.groups ?? []) {
    const member = state.members.find(
      (m) => m.group_id === group.id && m.tab_key === group.anchor_tab_key,
    );
    assert.ok(member, "Pane anchor has its actual persisted member");
    bind(
      group.id,
      "<pane:" + group.project_id + ":" + chat(member.tab_id) + ">",
    );
  }
}
function normalize(
  value,
  index,
  key = "",
  identity = "",
  role = "",
  field = "",
) {
  if (Array.isArray(value))
    return value.map((v) => normalize(v, index, "", identity, role, field));
  if (value && typeof value === "object") {
    if (
      (value.sourceKind && value.progress) ||
      (value.source_kind && value.progress)
    )
      role = "jobs";
    const id = value.id ?? value.attachment_id ?? identity;
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        normalize(
          v,
          index,
          k,
          id,
          [
            "jobs",
            "messages",
            "attachments",
            "chats",
            "sessions",
            "lanes",
            "projects",
            "groups",
            "members",
            "replicas",
          ].includes(k)
            ? k
            : role,
          typeof value.id === "string" ? k : field ? field + "." + k : k,
        ),
      ]),
    );
  }
  if (typeof value !== "string") return value;
  if (/(?:At|_at)$/.test(key) && /^\d{4}-/.test(value)) {
    const ms = Date.parse(value);
    assert.ok(Number.isSafeInteger(ms), key + ": " + value);
    if (known.has(ms)) return new Date(ms).toISOString();
    const offset = key === "lease_expires_at" ? 120000 : 0;
    const column = field.replace(/([A-Z])/g, "_$1").toLowerCase();
    const expected =
      role === "jobs" ? writes[index].get(identity)?.[column] : undefined;
    if (expected) {
      assert.ok(
        ms - offset >= expected.before && ms - offset <= expected.after,
        JSON.stringify({ identity, key, value, expected }),
      );
      const token = "<time:" + expected.label + (offset ? "+120000" : "") + ">";
      timeCache[index].set(role + ":" + identity + ":" + field, { ms, token });
      return token;
    }
    const cacheKey = role + ":" + identity + ":" + field,
      previous = timeCache[index].get(cacheKey);
    if (previous?.ms === ms) return previous.token;
    const window = windows[index].findLast(
      (w) => ms - offset >= w.before && ms - offset <= w.after,
    );
    assert.ok(
      window,
      JSON.stringify({ role, identity, key, value, windows: windows[index] }),
    );
    const token = "<time:" + window.label + (offset ? "+120000" : "") + ">";
    timeCache[index].set(cacheKey, { ms, token });
    return token;
  }
  if (
    /^[a-f0-9]{8}-[a-f0-9]{4}-[45][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value,
    ) &&
    ![owner, foreign].includes(value)
  ) {
    if (!aliases[index].has(value))
      aliases[index].set(value, "<generated:" + aliases[index].size + ">");
    return aliases[index].get(value);
  }
  if (
    ["tab_key", "anchor_tab_key"].includes(key) &&
    value.startsWith("chat:")
  ) {
    const id = value.slice(5);
    assert.ok(
      aliases[index].has(id) || id === "chat" || id === "other-chat",
      value,
    );
    return "chat:" + (aliases[index].get(id) ?? id);
  }
  return value;
}
async function observe(name, request, rejected = false, expectedDatabaseCode) {
  const outcomes = [];
  for (const [i, fixture] of pair.entries()) {
    const input = typeof request === "function" ? request(i) : request;
    let outcome;
    try {
      outcome = await fixture.request({
        ...input,
        observeOperationClock: true,
      });
    } catch (error) {
      report.interruptedObservation = {
        name,
        kind: launches[i].kind,
        input,
        error: String(error),
        diagnostics: fixture.diagnostics(),
      };
      throw error;
    }
    const clock = { ...outcome.operationClock, label: name };
    assert.ok(
      Number.isSafeInteger(clock.before) && Number.isSafeInteger(clock.after),
    );
    if (
      !outcome.rejected &&
      !readOnly.has(input.op) &&
      outcome.value !== null &&
      outcome.value !== false &&
      outcome.value !== 0
    )
      windows[i].push(clock);
    const job = outcome.value?.job ?? outcome.value;
    if (!outcome.rejected && job?.id && job?.progress) {
      const previous = writes[i].get(job.id);
      if (
        !readOnly.has(input.op) &&
        !(input.op === "chat-import-create" && previous)
      ) {
        writes[i].set(job.id, {
          ...previous,
          ...(!previous ? { created_at: clock, available_at: clock } : {}),
          ...(input.op === "chat-import-retry" ? { available_at: clock } : {}),
          ...(input.op === "chat-import-claim"
            ? {
                lease_expires_at: clock,
                ...(!previous?.started_at ? { started_at: clock } : {}),
              }
            : {}),
          ...(["succeeded", "failed"].includes(job.state)
            ? { completed_at: clock }
            : {}),
          updated_at: clock,
          "progress.updated_at": clock,
        });
      }
      if (job.startedAt !== null) {
        assert.ok(Date.parse(job.startedAt) <= Date.parse(job.updatedAt));
        assert.ok(Date.parse(job.createdAt) <= Date.parse(job.startedAt));
      }
    }
    if (input.op === "chat-import-renew" && outcome.value === true)
      writes[i].set(input.job, {
        ...writes[i].get(input.job),
        updated_at: clock,
        lease_expires_at: clock,
      });
    if (
      [
        "chat-import-recover",
        "chat-import-requeue",
        "chat-import-unsupported",
      ].includes(input.op) &&
      outcome.value > 0
    )
      for (const fields of writes[i].values())
        for (const key of [
          "updated_at",
          "lease_expires_at",
          "available_at",
          "completed_at",
          "progress.updated_at",
        ])
          delete fields[key];
    outcomes.push(outcome);
  }
  report.cases.push({ name, outcomes });
  for (const outcome of outcomes) {
    assert.equal(outcome.rejected, rejected, name + ": " + outcome.diagnostic);
    if (expectedDatabaseCode)
      assert.equal(
        outcome.databaseCode,
        expectedDatabaseCode,
        "Actual backend SQLSTATE",
      );
  }
  const comparable = (r, i) => {
    if (r.rejected && expectedDatabaseCode)
      return { databaseCode: r.databaseCode };
    if (r.rejected)
      return {
        diagnostic: r.diagnostic,
        importError: r.importError ?? "Error",
      };
    const input = typeof request === "function" ? request(i) : request;
    if (input.op === "query-json" && input.sql === stateQuery)
      bindStateIdentities(r.value, i);
    const value = normalize(r.value, i);
    // Raw table row order is keyed by generated IDs; preserve every field and
    // compare rows by the same aliased identity. Protocol arrays retain order.
    if (input.op === "query-json" && input.sql === stateQuery)
      for (const rows of Object.values(value))
        if (Array.isArray(rows))
          rows.sort((a, b) =>
            String(
              a.id ?? a.tab_key ?? a.attachment_id + ":" + a.worker_id,
            ).localeCompare(
              String(b.id ?? b.tab_key ?? b.attachment_id + ":" + b.worker_id),
              "en",
            ),
          );
    return { value };
  };
  assert.deepEqual(
    comparable(outcomes[1], 1),
    comparable(outcomes[0], 0),
    name,
  );
  return outcomes.map((v) => v.value);
}
async function seed(sql) {
  await observe("SQL " + report.cases.length, { op: "sql", sql });
}
const stateQuery =
  "SELECT jsonb_build_object('jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY created_at,id) FROM chat_import_jobs j),'chats',(SELECT jsonb_agg(to_jsonb(c) ORDER BY position,id) FROM chats c),'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY sequence) FROM chat_messages m),'attachments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM chat_attachments a),'replicas',(SELECT jsonb_agg(to_jsonb(r) ORDER BY attachment_id,worker_id) FROM chat_attachment_replicas r),'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY chat_id) FROM chat_runtime_sessions s),'lanes',(SELECT jsonb_agg(to_jsonb(l) ORDER BY chat_id) FROM chat_execution_lanes l),'projects',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM projects p),'groups',(SELECT jsonb_agg(to_jsonb(g) ORDER BY project_id,position) FROM tab_groups g),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY project_id,tab_kind,tab_id) FROM tab_group_members m),'leases',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM project_branch_leases l),'terminals',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM terminals t)) AS result";
async function snapshot(name) {
  const result = await observe(name, { op: "query-json", sql: stateQuery });
  report.snapshots.push({ name, result });
  for (const state of result) {
    for (const job of state.jobs ?? [])
      if (job.command_id) {
        const claim = windows[result.indexOf(state)].find(
          (w) =>
            Date.parse(job.lease_expires_at) - 120000 >= w.before &&
            Date.parse(job.lease_expires_at) - 120000 <= w.after,
        );
        assert.ok(claim, "Lease retains an actual claim/renewal clock");
      }
    for (const message of state.messages ?? []) {
      assert.equal(message.content, null);
      assert.equal(message.task_protected_content, null);
      assert.ok(message.protected_content);
    }
  }
  return result;
}
async function unchanged(name, request, expectedDatabaseCode) {
  const before = await snapshot("before " + name);
  await observe(name, request, true, expectedDatabaseCode);
  assert.deepEqual(
    await snapshot("after " + name),
    before,
    name + " preserves complete relevant durable state",
  );
}
const placement = {
  projectId: "github",
  workerId: "beta",
  projectReplicaId: "github-beta",
  worktreeId: "github-beta-main",
  surface: null,
};
const create = (name, changes = {}, rootChanges = {}) => ({
  op: "chat-import-create",
  owner,
  project: "github",
  input: {
    sourceKind: "chatgpt-codex",
    sourceWorkerId: "alpha",
    sourceId: "a".repeat(64),
    sourceThreadId: name,
    targetPlacement: placement,
    modelId: null,
    modelRouteId: null,
    providerAccountId: null,
    permissionProfileId: null,
    planMode: "default",
    idempotencyKey: name,
    ...changes,
  },
  ...rootChanges,
});
const op =
  (name, claims, extra = {}) =>
  (i) => ({
    op: "chat-import-" + name,
    job: claims[i].job.id,
    command: claims[i].commandId,
    attempt: claims[i].job.attempt,
    ...(typeof extra === "function" ? extra(i) : extra),
  });
function transcript(job, { count = 2, attachments = 0, empty = false } = {}) {
  const descriptors = Array.from({ length: attachments }, (_, n) => {
    const sourceAttachmentId = createHash("sha256")
      .update("attachment-" + n)
      .digest("hex");
    return {
      id: chatImportAttachmentId(job.id, sourceAttachmentId),
      sourceAttachmentId,
      itemId: "item-0",
      sizeBytes: 128 + n,
      status: ["available", "missing", "unsupported"][n % 3],
      protectedMetadata: protectedAttachmentMetadataFixture("import-" + n),
    };
  });
  const turns = empty
    ? []
    : [
        {
          id: "turn",
          status: "completed",
          startedAt: 1786800000,
          completedAt: 1786800010,
          durationMs: 10000,
          items: Array.from({ length: count }, (_, n) => ({
            type: "userMessage",
            id: "item-" + n,
            text:
              n === 0 ? "Encrypted import 😀 \ud800 \u2028" : "Message " + n,
            externalAttachmentIds: n === 0 ? descriptors.map((a) => a.id) : [],
          })),
        },
      ];
  return externalChatTranscriptSchema.parse({
    sourceId: job.sourceId,
    sourceThreadId: job.sourceThreadId,
    titleProtection: label("chat"),
    metadata: {
      sourceThreadId: job.sourceThreadId,
      preview: "External history",
      cwd: "/fixture/github-alpha",
      createdAt: stamp,
      updatedAt: stamp,
      source: "vscode",
      status: "not-loaded",
      modelProvider: "openai",
      cliVersion: "0.149.0",
      git: null,
      match: {
        kind: "worktree-path",
        projectReplicaId: "github-alpha",
        worktreeId: "github-alpha-main",
      },
    },
    sync: { threadId: job.sourceThreadId, status: "idle", turns },
    attachments: descriptors,
  });
}
const canonical = (claims, options = {}, extra = {}) =>
  op("canonical", claims, (i) => {
    const t = transcript(claims[i].job, options);
    return {
      transcript: t,
      attachments: t.attachments.map((descriptor) => ({
        descriptor,
        id: descriptor.id,
      })),
      ...extra,
    };
  });
async function begin(name, changes = {}) {
  const created = await observe("create " + name, create(name, changes));
  const claimed = await observe("claim " + name, { op: "chat-import-claim" });
  for (let i = 0; i < 2; i++) {
    assert.equal(claimed[i].job.id, created[i].id);
    assert.equal(claimed[i].job.state, "reading");
  }
  await observe("mark " + name, op("mark", claimed));
  return claimed;
}
try {
  const executable =
    process.env.CANTRIP_RUST_REPOSITORY_BINARY ??
    (await buildRustExample("project-repository-fixture"));
  report.executable = executable;
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const kind of ["node", "rust"]) {
    const launch = {
      kind,
      executable,
      root,
      databaseMode: values.database,
      onReplyLine: (line) =>
        appendFileSync(
          path.join(root, kind + "-raw-replies.jsonl"),
          JSON.stringify({ line }) + "\n",
        ),
      databaseUrl:
        pg && (kind === "node" || values.database === "postgres")
          ? await pg.database()
          : undefined,
    };
    launches.push(launch);
    pair.push(await repositoryFixture(launch));
  }
  for (const sql of targetStateSql()) await seed(sql);
  await seed("UPDATE chats SET last_used_at=" + literal(stamp));
  await seed(
    "INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('import-provider'," +
      literal(owner) +
      ",'Provider','ollama','https://model.invalid/v1')",
  );
  await seed(
    "INSERT INTO model_profiles(id,owner_id,name) VALUES('import-model'," +
      literal(owner) +
      ",'Model')",
  );
  await seed(
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('import-route','import-model','import-provider','model',0,true)",
  );
  await seed(
    "INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state,created_at,updated_at) VALUES('github-beta-feature','github-beta','beta','feature','/fixture/feature','/fixture/feature',false,'cantrip','ready'," +
      literal(stamp) +
      "," +
      literal(stamp) +
      ")",
  );
  await observe("missing owned job", {
    op: "chat-import-get",
    owner,
    job: "missing",
  });
  await observe("owned empty list", {
    op: "chat-import-list",
    owner,
    project: "github",
  });
  await observe("foreign project list hidden", {
    op: "chat-import-list",
    owner: foreign,
    project: "github",
  });
  await observe("no claim", { op: "chat-import-claim" });
  await observe("empty reference selection", {
    op: "chat-import-references",
    owner,
    workers: [],
  });
  for (const [name, changes, rootChanges] of [
    ["missing project", {}, { project: "missing" }],
    ["foreign owner", {}, { owner: foreign }],
    ["foreign source", { sourceWorkerId: "foreign" }],
    [
      "not a project target",
      { targetPlacement: { ...placement, projectId: "other" } },
    ],
    [
      "surface target",
      {
        targetPlacement: {
          ...placement,
          surface: { kind: "chat", id: "chat" },
        },
      },
    ],
    [
      "missing worktree",
      { targetPlacement: { ...placement, worktreeId: null } },
    ],
    ["missing model", { modelId: "missing" }],
    ["mismatched route", { modelRouteId: "import-route" }],
    [
      "missing account",
      {
        modelId: "import-model",
        modelRouteId: "import-route",
        providerAccountId: "missing",
      },
    ],
  ])
    await unchanged(name, create(name, changes, rootChanges));
  const request = create("first");
  const created = await observe("first admission", request);
  const replay = await observe("identical admission replay", request);
  assert.deepEqual(replay, created);
  const duplicate = await observe(
    "same source another key",
    create("unused-key", { sourceThreadId: "first" }),
  );
  assert.deepEqual(duplicate, created);
  await unchanged(
    "changed idempotency payload",
    create("first", { planMode: "plan" }),
  );
  await unchanged(
    "changed source target",
    create("another-key", {
      sourceThreadId: "first",
      targetPlacement: { ...placement, worktreeId: "github-beta-feature" },
    }),
  );
  const fingerprint = await observe("exact admission fingerprint", (i) => ({
    op: "query-json",
    sql:
      "SELECT to_jsonb(payload_fingerprint) AS result FROM chat_import_jobs WHERE id=" +
      literal(created[i].id),
  }));
  const { idempotencyKey, ...input } = request.input;
  const expected = createHash("sha256")
    .update(
      JSON.stringify({
        projectId: "github",
        sourceKind: input.sourceKind,
        sourceWorkerId: input.sourceWorkerId,
        sourceId: input.sourceId,
        sourceThreadId: input.sourceThreadId,
        targetPlacement: input.targetPlacement,
        modelId: input.modelId,
        modelRouteId: input.modelRouteId,
        providerAccountId: input.providerAccountId,
        permissionProfileId: input.permissionProfileId,
        planMode: input.planMode,
      }),
    )
    .digest("hex");
  for (const hash of fingerprint) assert.equal(hash, expected);
  await observe("hidden job", (i) => ({
    op: "chat-import-get",
    owner: foreign,
    job: created[i].id,
  }));
  await observe("source references", {
    op: "chat-import-references",
    owner,
    workers: ["alpha", "alpha", "foreign"],
  });
  const claimed = await observe("claim reading", { op: "chat-import-claim" });
  for (const c of claimed) {
    assert.equal(c.job.state, "reading");
    assert.equal(c.job.attempt, 1);
  }
  await observe("source discovery context", op("read", claimed));
  await observe(
    "wrong read command",
    op("read", claimed, { command: "wrong" }),
  );
  await observe("renew wrong attempt", op("renew", claimed, { attempt: 0 }));
  await observe("renew durable lease", op("renew", claimed));
  await unchanged(
    "stale reading result",
    op("mark", claimed, { command: "wrong" }),
  );
  await observe("mark importing", op("mark", claimed));
  await snapshot("marked importing");
  await unchanged("source identity changed", (i) => ({
    ...canonical(claimed)(i),
    transcript: { ...transcript(claimed[i].job), sourceThreadId: "changed" },
  }));
  await unchanged("inconsistent attachment set", (i) => ({
    ...canonical(claimed, { attachments: 1 })(i),
    attachments: [],
  }));
  for (const protection of ["throw", "truncate", "bad-key"])
    await unchanged(
      "protection " + protection,
      canonical(claimed, { attachments: 3 }, { protection }),
    );
  const canonicalResult = await observe(
    "canonical protected import",
    canonical(claimed, { attachments: 3 }),
  );
  for (const r of canonicalResult) {
    assert.equal(r.job.state, "awaiting-hydration");
    assert.equal(r.job.attachmentCount, 3);
    assert.equal(r.job.attachmentWarningCount, 2);
    assert.equal(r.protectionCalls[0].messages.length, 2);
  }
  const stored = await snapshot("canonical transaction");
  const hydrating = await observe("claim hydration", {
    op: "chat-import-claim",
  });
  for (const h of hydrating) {
    assert.equal(h.job.attempt, 2);
    assert.equal(h.job.state, "hydrating");
  }
  const payload = await observe(
    "protected hydration context",
    op("hydration", hydrating),
  );
  for (const p of payload) {
    assert.equal(p.payload.messages.length, 2);
    assert.equal(p.payload.attachments.length, 3);
  }
  const finish = {
    modelId: "import-model",
    modelRouteId: "import-route",
    providerAccountId: null,
    threadId: "managed-import",
  };
  await unchanged(
    "cannot adopt external thread",
    op("complete", hydrating, { input: { ...finish, threadId: "first" } }),
  );
  const now = new Date().toISOString();
  known.add(Date.parse(now));
  for (const count of await observe("unexpired hydration untouched", {
    op: "chat-import-recover",
    force: false,
    now,
  }))
    assert.equal(count, 0);
  for (const count of await observe("recover post-canonical hydration", {
    op: "chat-import-recover",
    force: true,
    now,
  }))
    assert.equal(count, 1);
  const reclaimed = await observe("reclaim canonical state", {
    op: "chat-import-claim",
  });
  for (const r of reclaimed) assert.equal(r.job.attempt, 3);
  await unchanged(
    "old attempt cannot complete",
    op("complete", hydrating, { input: finish }),
  );
  const beforeReopen = await snapshot("before actual process reopen");
  report.reopen = [];
  for (let i = 0; i < 2; i++) {
    await pair[i].close();
    report.reopen.push({ kind: launches[i].kind, closedCleanly: true });
    pair[i] = await repositoryFixture(launches[i]);
  }
  assert.deepEqual(await snapshot("after actual process reopen"), beforeReopen);
  const now2 = new Date().toISOString();
  known.add(Date.parse(now2));
  await observe("recover after reopen", {
    op: "chat-import-recover",
    force: true,
    now: now2,
  });
  const finalClaim = await observe("final hydration claim", {
    op: "chat-import-claim",
  });
  const afterPayload = await observe(
    "same canonical context after restart",
    op("hydration", finalClaim),
  );
  assert.deepEqual(afterPayload, payload);
  await observe(
    "attach managed runtime",
    op("complete", finalClaim, { input: finish }),
  );
  const completed = await snapshot("completed managed import");
  for (let i = 0; i < 2; i++) {
    assert.equal(completed[i].jobs[0].state, "succeeded");
    assert.equal(completed[i].sessions[0].status, "attached");
    assert.deepEqual(completed[i].messages, stored[i].messages);
  }
  await unchanged(
    "late settle rejected",
    op("settle", reclaimed, {
      state: "failed",
      error: { code: "worker-error", retryable: true },
    }),
  );
  const unsupported = await begin("unsupported", {
    targetPlacement: { ...placement, worktreeId: "github-beta-feature" },
  });
  await observe("canonical pinned import", canonical(unsupported));
  const missingRuntime = await observe("claim unsupported hydration", {
    op: "chat-import-claim",
  });
  await observe(
    "missing runtime blocked",
    op("settle", missingRuntime, {
      state: "blocked",
      error: { code: "capability-missing", retryable: false },
    }),
  );
  for (const n of await observe("upgrade prior unsupported history", {
    op: "chat-import-unsupported",
  }))
    assert.equal(n, 1);
  await snapshot("unsupported retains canonical history");
  let retryable = await begin("retry");
  await observe("expire pre-canonical lease", (i) => ({
    op: "sql",
    sql:
      "UPDATE chat_import_jobs SET lease_expires_at=" +
      literal(stamp) +
      " WHERE id=" +
      literal(retryable[i].job.id),
  }));
  const recoveryTime = new Date().toISOString();
  known.add(Date.parse(recoveryTime));
  for (const n of await observe(
    "recover actually expired pre-canonical lease",
    { op: "chat-import-recover", force: false, now: recoveryTime },
  ))
    assert.equal(n, 1);
  retryable = await observe("reclaim pre-canonical work", {
    op: "chat-import-claim",
  });
  const blocked = await observe(
    "source offline block",
    op("settle", retryable, {
      state: "blocked",
      error: { code: "worker-offline", retryable: true },
    }),
  );
  await observe("stale revision retry", (i) => ({
    op: "chat-import-retry",
    owner,
    job: blocked[i].id,
    revision: blocked[i].stateRevision - 1,
  }));
  await observe("foreign retry", (i) => ({
    op: "chat-import-retry",
    owner: foreign,
    job: blocked[i].id,
    revision: blocked[i].stateRevision,
  }));
  for (const n of await observe("target reconnect cannot requeue source", {
    op: "chat-import-requeue",
    worker: "beta",
  }))
    assert.equal(n, 0);
  for (const n of await observe("source reconnect requeues", {
    op: "chat-import-requeue",
    worker: "alpha",
  }))
    assert.equal(n, 1);
  const retried = await observe("claim requeued source", {
    op: "chat-import-claim",
  });
  const failed = await observe(
    "nonretryable source failure",
    op("settle", retried, {
      state: "failed",
      error: { code: "source-changed", retryable: false },
    }),
  );
  await observe("explicit retry failed import", (i) => ({
    op: "chat-import-retry",
    owner,
    job: failed[i].id,
    revision: failed[i].stateRevision,
  }));
  const empty = await observe("claim empty import", {
    op: "chat-import-claim",
  });
  await observe("mark empty import", op("mark", empty));
  await observe("empty canonical import", canonical(empty, { empty: true }));
  const emptyHydration = await observe("claim empty hydration", {
    op: "chat-import-claim",
  });
  await observe(
    "complete without native hydration",
    op("without", emptyHydration),
  );
  const large = await begin("large");
  await unchanged(
    "later batch SQL constraint rolls back complete import",
    canonical(
      large,
      { count: 1001, attachments: 3 },
      { protection: "duplicate-after-first-batch" },
    ),
    "23505",
  );
  await observe(
    "more than one message batch",
    canonical(large, { count: 1001, attachments: 3 }),
  );
  const largeHydration = await observe("claim large history", {
    op: "chat-import-claim",
  });
  const largePayload = await observe(
    "read all large canonical messages",
    op("hydration", largeHydration),
  );
  for (const p of largePayload) assert.equal(p.payload.messages.length, 1001);
  await observe(
    "post-canonical worker unavailable",
    op("settle", largeHydration, {
      state: "blocked",
      error: { code: "worker-offline", retryable: true },
    }),
  );
  for (const n of await observe("source cannot requeue canonical hydration", {
    op: "chat-import-requeue",
    worker: "alpha",
  }))
    assert.equal(n, 0);
  for (const n of await observe(
    "target reconnect requeues canonical hydration",
    { op: "chat-import-requeue", worker: "beta" },
  ))
    assert.equal(n, 1);
  const largeRetry = await observe("reclaim large hydration", {
    op: "chat-import-claim",
  });
  assert.deepEqual(
    await observe(
      "canonical history unchanged after target retry",
      op("hydration", largeRetry),
    ),
    largePayload,
  );
  await observe(
    "complete large history without runtime",
    op("without", largeRetry),
  );
  const smallBatch = await begin("small-batch");
  await observe(
    "small configured message and attachment batches",
    canonical(smallBatch, { count: 7, attachments: 9 }, { batchSize: 2 }),
  );
  const smallHydration = await observe("claim small batches", {
    op: "chat-import-claim",
  });
  await observe("complete small batches", op("without", smallHydration));
  await observe("owned import history", {
    op: "chat-import-list",
    owner,
    project: "github",
  });
  await observe("completed source references", {
    op: "chat-import-references",
    owner,
    workers: ["alpha"],
  });
  await snapshot("final complete relevant state");
  // Completed histories may outlive a deleted Chat. Exercise the real bound
  // and timestamp-tie ordering with a separate owner's historical rows.
  await seed(
    "INSERT INTO chat_import_jobs(id,owner_id,project_id,source_kind,source_worker_id,source_id,source_thread_id,target_placement,state,idempotency_key,payload_fingerprint,progress,available_at,completed_at,created_at,updated_at) SELECT '90000000-0000-1000-8000-'||lpad(n::text,12,'0')," +
      literal(foreign) +
      ",'other','chatgpt-codex','foreign',repeat('b',64),'history-'||n," +
      json({
        projectId: "other",
        workerId: "foreign",
        projectReplicaId: "other-foreign",
        worktreeId: "other-foreign-main",
        surface: null,
      }) +
      ",'succeeded','history-'||n,repeat('c',64)," +
      json({ stage: "succeeded", percent: 100, updatedAt: stamp }) +
      "," +
      literal(stamp) +
      "," +
      literal(stamp) +
      "," +
      literal(stamp) +
      "," +
      literal(stamp) +
      " FROM generate_series(1,1001) AS fixture(n)",
  );
  const histories = await observe(
    "newest 1000 histories retain ascending presentation",
    { op: "chat-import-list", owner: foreign, project: "other" },
  );
  for (const history of histories) {
    assert.equal(history.length, 1000);
    assert.deepEqual(
      history.map((j) => j.id),
      Array.from(
        { length: 1000 },
        (_, n) => "90000000-0000-1000-8000-" + String(n + 2).padStart(12, "0"),
      ),
    );
  }
  report.passed = true;
} finally {
  report.shutdown = [];
  for (const fixture of pair)
    try {
      await fixture.close();
      report.shutdown.push({ clean: true });
    } catch (error) {
      report.shutdown.push({
        clean: false,
        error: String(error),
        diagnostics: fixture.diagnostics(),
      });
      report.passed = false;
    }
  if (pg) await pg.close();
  if (values.report) {
    const file = path.resolve(values.report);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(report, null, 2) + "\n");
  }
}
assert.equal(report.passed, true);
