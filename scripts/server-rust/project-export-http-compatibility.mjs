// Paired real HTTP + App Live + unchanged WorkerConnection. Only external
// Codex/file operations are controlled; all server reads and relays are real.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  copyFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { parseArgs } from "node:util";
import { buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { eventually } from "./full-worker.mjs";
import { exportWorker } from "./project-export-http-worker.mjs";
import { exportShutdown } from "./project-export-http-lifecycle.mjs";
import { password } from "./security-fixtures.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { encodeCanonicalChatPayload } from "../../cantrip_server/src/chats/hydration.ts";
import {
  targetStateSql,
  localOwner,
  otherOwner,
  label,
  literal,
  json,
  stamp,
} from "./project-target-state.mjs";
const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    profile: { type: "string" },
    report: { type: "string" },
    lifecycle: { type: "boolean", default: false },
  },
});
const root = await mkdtemp(path.join(tmpdir(), "cantrip-project-export-http-"));
process.stderr.write(
  JSON.stringify({ event: "project-export.http.created", root }) + "\n",
);
const report = {
  root,
  database: values.database,
  profiles: [],
  completeReplacement: false,
  scope:
    "Real production HTTP/SQL/Live/WorkerConnection with controlled export operations; native Codex replay is not claimed",
};
const worktreeId = "github-alpha-main",
  project = "11111111-1111-4111-8111-000000000001";
const projectIds = {
  github: project,
  folder: "11111111-1111-4111-8111-000000000002",
  "local-git": "11111111-1111-4111-8111-000000000003",
  other: "11111111-1111-4111-8111-000000000004",
};
const target = { kind: "codex-local" };
const snapshotQuery =
  "SELECT jsonb_build_object('chats',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM chats c),'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY sequence) FROM chat_messages m),'projects',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM projects p),'sources',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM project_sources s),'worktrees',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM project_worktrees w),'jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM chat_import_jobs j))::text AS result";
function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function headers(f, body) {
  const client = f.client();
  return {
    origin: "http://127.0.0.1:5173",
    connection: "close",
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    cookie: [...client.cookies].map(([k, v]) => k + "=" + v).join("; "),
    ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
  };
}
async function run(f, profile, result) {
  const state = {
    commands: [],
    completed: [],
    background: [],
    uploads: new Map(),
    heartbeatFailures: [],
  };
  let worker, live, ownerIdentity;
  const evidenceDirectory = path.join(root, profile, f.kind, "observations");
  await mkdir(evidenceDirectory, { recursive: true });
  const visit = async (name, method, url, options = {}) => {
    const observation = await f.observe(name, method, url, {
      csrf: true,
      ...options,
    });
    if (name === "actual message query failure") {
      for (const outcome of observation.body.outcomes) {
        assert.ok(outcome.message.startsWith("Failed query: "));
        assert.ok(
          outcome.message.endsWith(
            "\nparams: agent," + ownerIdentity + "," + outcome.chatId,
          ),
        );
        outcome.message = outcome.message.replaceAll(ownerIdentity, "<owner>");
      }
    }
    result.http.push({
      name,
      ...observation,
    });
    return f.records.get(name);
  };
  const body = (chatIds = ["chat"], changes = {}) => ({
    operationId:
      "33333333-3333-4333-8333-" +
      String(result.http.length + 1).padStart(12, "0"),
    target,
    worktreeId,
    chatIds,
    ...changes,
  });
  const endpoint = "/api/projects/" + project + "/exports";
  const sqlState = async () => (await f.sql([], [snapshotQuery]))[0];
  const settled = async (
    name,
    input,
    { preview = false, status = 200, url, ...options } = {},
  ) => {
    const before = await sqlState(),
      offset = state.commands.length,
      completedOffset = state.completed.length;
    await live.ping("before " + name);
    const eventOffset = live.history.length;
    const response = await visit(
      name,
      "POST",
      url ?? endpoint + (preview ? "/preview" : ""),
      { json: input, status, ...options },
    );
    await live.ping("after " + name);
    const after = await sqlState();
    assert.deepEqual(
      after,
      before,
      "Exports must not mutate canonical server state: " + name,
    );
    const commands = state.commands.slice(offset),
      completed = state.completed.slice(completedOffset);
    for (const complete of completed) {
      assert.deepEqual(
        Buffer.from(complete.bytes, "base64"),
        encodeCanonicalChatPayload(complete.payload),
        "Exact Source canonical UTF-16 sorting and serialization",
      );
      const expected = f.records.get(
        "encrypted messages " + complete.chatId,
      ).messages;
      assert.deepEqual(complete.payload.messages, expected);
    }
    const events = live.history
      .slice(eventOffset)
      .filter((frame) => frame.type === "event")
      .map((frame) => ({
        resource: frame.resource,
        action: frame.action,
        entityId: frame.entityId,
      }));
    const snapshot = JSON.stringify(after);
    const rawStatePath = path.join(
      evidenceDirectory,
      createHash("sha256").update(snapshot).digest("hex") + ".json",
    );
    await writeFile(rawStatePath, snapshot + "\n");
    result.cases.push({
      name,
      response: f.normalize(response),
      commands,
      completed,
      events,
      rawStatePath,
    });
    return response;
  };
  const reset = () => {
    for (const field of [
      "mode",
      "failType",
      "failChat",
      "failureMessage",
      "inspection",
      "intercept",
    ])
      delete state[field];
  };
  try {
    await f.start();
    const authName =
      profile === "accounts"
        ? "register"
        : profile === "password"
          ? "login"
          : "session";
    if (profile === "accounts")
      await visit(authName, "POST", "/api/auth/register", {
        status: 201,
        json: {
          email: "exports@example.invalid",
          displayName: "Export",
          password,
        },
      });
    else if (profile === "password")
      await visit(authName, "POST", "/api/auth/login", { json: { password } });
    else await visit(authName, "GET", "/api/auth/session");
    const owner = f.records.get(authName).currentUser?.id ?? localOwner;
    ownerIdentity = owner;
    worker = await exportWorker({
      fixture: f,
      visit,
      root: path.join(root, profile, f.kind),
      state,
    });
    await f.sql([
      ...targetStateSql(owner, otherOwner, projectIds).filter(
        (sql) => !/^INSERT INTO workers.*VALUES\('alpha'/.test(sql),
      ),
      "UPDATE chats SET last_used_at=" + literal(stamp),
      ...["second", "third", "empty", "task"].map(
        (id) =>
          `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,experience,created_at,updated_at,last_used_at) VALUES(${literal(id)},${literal(owner)},${literal(project)},${literal(worktreeId)},'alpha',${json(label("chat"))},${literal(id === "task" ? "task" : "agent")},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
      ),
    ]);
    const protectedContent = structuredClone(label("chat").protectedLabel);
    protectedContent.envelope.ciphertext = "A".repeat(100000);
    const attachmentId = "44444444-4444-4444-8444-000000000001";
    for (const [index, chatId] of ["chat", "second", "third"].entries()) {
      await f.sql([
        ...["assistant", "user", "system", "assistant"].map(
          (role, n) =>
            `INSERT INTO chat_messages(id,chat_id,worktree_id,sequence,role,protected_content,attachment_ids,created_at) VALUES(${literal(chatId + "-" + n)},${literal(chatId)},${literal(worktreeId)},${index * 10 + n + 1},${literal(role)},${json(protectedContent)},${json(n === 1 ? [attachmentId] : [])},${literal(stamp)})`,
        ),
      ]);
    }
    await f.sql([
      `INSERT INTO chat_messages(id,chat_id,worktree_id,sequence,role,content,created_at) VALUES('legacy-plaintext','chat',${literal(worktreeId)},100,'user','[{"type":"text","text":"PLAINTEXT MUST NOT BE EXPORTED"}]',${literal(stamp)})`,
    ]);
    for (const chatId of ["chat", "second", "third", "empty"])
      await visit(
        "encrypted messages " + chatId,
        "GET",
        "/api/chats/" + chatId + "/messages",
      );
    live = await new LiveProbe(f).open();
    await live.initialized();
    await live.subscribed("export scopes", [
      { kind: "project", projectId: project },
    ]);
    const preview = { target, worktreeId };
    await settled("preview", preview, { preview: true });
    for (const input of [
      {},
      { ...preview, extra: true },
      { ...preview, target: { kind: "unknown" } },
      { ...preview, worktreeId: null },
    ])
      await settled("invalid preview " + result.cases.length, input, {
        preview: true,
        status: 400,
      });
    for (const input of [
      {},
      body([]),
      body(["chat", "chat"]),
      body(["chat"], { extra: true }),
      body(["chat"], { operationId: "bad" }),
      body(Array.from({ length: 21 }, (_, i) => "chat" + i)),
    ])
      await settled("invalid export " + result.cases.length, input, {
        status: 400,
      });
    for (const previewMode of [true, false]) {
      const input = previewMode ? preview : body();
      await settled("missing project " + previewMode, input, {
        preview: previewMode,
        url: "/api/projects/missing/exports" + (previewMode ? "/preview" : ""),
        status: 404,
      });
      await settled(
        "foreign project " + previewMode,
        { ...input, worktreeId: "other-foreign-main" },
        {
          preview: previewMode,
          url:
            "/api/projects/" +
            projectIds.other +
            "/exports" +
            (previewMode ? "/preview" : ""),
          status: 404,
        },
      );
      await settled(
        "missing worktree " + previewMode,
        { ...input, worktreeId: "absent" },
        { preview: previewMode, status: 404 },
      );
      await f.sql([
        "UPDATE project_worktrees SET lifecycle_state='removing' WHERE id=" +
          literal(worktreeId),
      ]);
      await settled("unready worktree " + previewMode, input, {
        preview: previewMode,
        status: 404,
      });
      await f.sql([
        "UPDATE project_worktrees SET lifecycle_state='ready' WHERE id=" +
          literal(worktreeId),
      ]);
      await f.sql([
        "UPDATE project_sources SET removed_at=" +
          literal(stamp) +
          " WHERE id='github-alpha'",
      ]);
      await settled("removed replica " + previewMode, input, {
        preview: previewMode,
        status: 404,
      });
      await f.sql([
        "UPDATE project_sources SET removed_at=NULL WHERE id='github-alpha'",
      ]);
      await f.sql([
        "UPDATE workers SET unlinked_at=" +
          literal(stamp) +
          " WHERE id='alpha'",
      ]);
      await settled("unlinked worker " + previewMode, input, {
        preview: previewMode,
        status: 404,
      });
      await f.sql(["UPDATE workers SET unlinked_at=NULL WHERE id='alpha'"]);
    }
    await f.sql([
      "UPDATE workers SET external_codex_history_capability=false WHERE id='alpha'",
    ]);
    await settled("unsupported preview", preview, { preview: true });
    await settled("unsupported export", body(), { status: 409 });
    await worker.pulse();
    await f.sql([
      "UPDATE workers SET last_seen_at='2000-01-01' WHERE id='alpha'",
    ]);
    await settled("offline preview", preview, { preview: true });
    await settled("offline export", body(), { status: 503 });
    await worker.pulse();
    await settled("foreign selection", body(["other-chat"]), { status: 404 });
    await f.sql(["UPDATE chats SET status='running' WHERE id='chat'"]);
    await settled(
      "missing selection precedes running",
      body(["chat", "absent"]),
      { status: 404 },
    );
    await f.sql(["UPDATE chats SET status='idle' WHERE id='chat'"]);
    await f.sql([
      "UPDATE chats SET archived_at=" + literal(stamp) + " WHERE id='chat'",
    ]);
    await settled("archived selection", body(), { status: 404 });
    await f.sql([
      "UPDATE chats SET archived_at=NULL,status='running' WHERE id='chat'",
    ]);
    await settled("unsupported type precedes running", body(["chat", "task"]), {
      status: 409,
    });
    await settled("running selection", body(), { status: 409 });
    await f.sql([
      "UPDATE chats SET status='waiting-for-approval' WHERE id='chat'",
    ]);
    await settled("approval selection", body(), { status: 409 });
    await f.sql(["UPDATE chats SET status='idle' WHERE id='chat'"]);
    for (const inspection of [
      {},
      {
        target,
        available: false,
        destinationLabel: null,
        message: "Target unavailable",
        platform: "linux",
      },
      {
        target,
        available: true,
        destinationLabel: "Destination",
        message: null,
        platform: "linux",
        extra: true,
      },
    ]) {
      state.inspection = inspection;
      await settled("inspection response " + result.cases.length, preview, {
        preview: true,
      });
    }
    reset();
    state.failType = "project.export.target.inspect";
    for (const failureMessage of [
      "Controlled inspect failure",
      "x".repeat(1999) + "😀 beyond",
    ]) {
      state.failureMessage = failureMessage;
      await settled("inspection failure " + result.cases.length, preview, {
        preview: true,
      });
    }
    reset();
    const success = body(["third", "empty", "chat", "second"]);
    const first = await settled("ordered opaque exports", success);
    assert.deepEqual(
      first.outcomes.map((outcome) => outcome.chatId),
      success.chatIds,
    );
    assert.ok(
      state.commands.some(
        (command) =>
          command.type === "project.export.chat.chunk" &&
          command.chunkIndex > 0,
      ),
    );
    const reused = await settled("same operation reused", success);
    assert.ok(reused.outcomes.every((outcome) => outcome.reused));
    await f.sql([
      "UPDATE chat_messages SET role='developer' WHERE id='second-0'",
    ]);
    const invalidMessage = await settled(
      "invalid encrypted message settles only its Chat",
      body(["third", "second", "chat"]),
    );
    assert.deepEqual(
      invalidMessage.outcomes.map((outcome) => outcome.status),
      ["exported", "failed", "exported"],
    );
    await f.sql([
      "UPDATE chat_messages SET role='assistant' WHERE id='second-0'",
    ]);
    for (const mode of [
      "arbitrary-chunk-ack",
      "different-result-chat",
      "invalid-begin",
      "invalid-reuse",
      "invalid-complete",
    ]) {
      state.mode = mode;
      await settled(mode, body());
    }
    reset();
    state.mode = "lost-complete-ack";
    const lost = body();
    const failed = await settled("lost completion acknowledgment", lost);
    assert.equal(failed.outcomes[0].status, "failed");
    reset();
    assert.equal(
      (await settled("retry lost acknowledgment", lost)).outcomes[0].reused,
      true,
    );
    const failures = [
      [
        "project.export.chat.begin",
        "encrypt external codex home runtime",
        "encryption-unavailable",
      ],
      [
        "project.export.chat.chunk",
        "external codex home runtime",
        "target-unavailable",
      ],
      [
        "project.export.chat.complete",
        "thread/inject_items",
        "runtime-incompatible",
      ],
      [
        "project.export.chat.begin",
        "Controlled generic failure",
        "worker-error",
      ],
      ["project.export.chat.begin", "PRIVATE LABEL", "encryption-unavailable"],
      ["project.export.chat.begin", "worKer iſ offline", "target-unavailable"],
      [
        "project.export.chat.begin",
        "x".repeat(2000) + "encrypt",
        "worker-error",
      ],
      [
        "project.export.chat.begin",
        "x".repeat(1999) + "😀encrypt",
        "worker-error",
      ],
    ];
    for (const [failType, failureMessage, code] of failures) {
      reset();
      Object.assign(state, { failType, failureMessage, failChat: "second" });
      const response = await settled(
        "partial failure " + result.cases.length,
        body(["third", "second", "chat"]),
      );
      assert.deepEqual(
        response.outcomes.map((outcome) => outcome.status),
        ["exported", "failed", "exported"],
      );
      assert.equal(response.outcomes[1].code, code);
      assert.equal(
        response.outcomes[1].message,
        failureMessage.slice(0, 2000) || "Could not export this chat.",
      );
    }
    reset();
    const beforeFault = await sqlState(),
      faultOffset = state.commands.length;
    await f.sql([
      "ALTER TABLE chat_messages RENAME TO export_temporarily_unavailable_messages",
    ]);
    try {
      result.databaseFault = await visit(
        "actual message query failure",
        "POST",
        endpoint,
        { json: body(["third", "second", "chat"]) },
      );
      assert.deepEqual(
        result.databaseFault.outcomes.map((outcome) => outcome.status),
        ["failed", "failed", "failed"],
      );
      assert.equal(state.commands.length, faultOffset);
    } finally {
      await f.sql([
        "ALTER TABLE export_temporarily_unavailable_messages RENAME TO chat_messages",
      ]);
    }
    assert.deepEqual(
      await sqlState(),
      beforeFault,
      "A real failed SELECT must not write server state",
    );
    if (values.lifecycle) {
      const held = deferred(),
        release = deferred(),
        input = body(["third", "empty"]);
      state.intercept = async (command) => {
        if (
          command.type === "project.export.chat.begin" &&
          command.chatId === "third"
        ) {
          held.resolve();
          await release.promise;
        }
      };
      const data = JSON.stringify(input);
      const callerClosed = deferred();
      const caller = httpRequest(f.server.origin + endpoint, {
        method: "POST",
        headers: headers(f, data),
      });
      caller.on("error", (error) => {
        result.callerError = error.code;
      });
      caller.once("close", callerClosed.resolve);
      caller.end(data);
      await held.promise;
      caller.destroy();
      await callerClosed.promise;
      const completedOffset = state.completed.length;
      release.resolve();
      await eventually(
        () => state.completed.length,
        (count) => assert.equal(count, completedOffset + 2),
      );
      result.disconnectedCaller = state.completed.slice(completedOffset);
      reset();
    }
    // A connected worker with a fresh durable heartbeat still requires an
    // actual bridge connection, rather than just the SQL online projection.
    await worker.close();
    result.disconnectPolls = [];
    await eventually(
      async () => {
        const response = await f.observe(
          "disconnect readiness",
          "POST",
          endpoint + "/preview",
          { csrf: true, json: preview },
        );
        result.disconnectPolls.push(response);
        return response.body.available;
      },
      (available) => assert.equal(available, false),
    );
    await settled("disconnected preview", preview, { preview: true });
    await settled("disconnected export", body(), { status: 503 });
    await worker.start();
    await settled("reconnected export reuse", success);
    if (values.lifecycle) {
      const restarted = await exportShutdown({
        fixture: f,
        state,
        worker,
        live,
        visit,
        body,
        endpoint,
        sqlState,
        settled,
        reset,
        result,
        project,
        deferred,
      });
      live = restarted.live;
      await restarted.retry();
    }
    assert.deepEqual(state.heartbeatFailures, []);
  } catch (error) {
    result.failure = error.stack;
    throw error;
  } finally {
    result.rawCommandsPath = path.join(
      evidenceDirectory,
      "worker-commands.json",
    );
    await writeFile(
      result.rawCommandsPath,
      JSON.stringify(state.commands) + "\n",
    );
    result.background = state.background;
    result.diagnostics = f.server?.diagnostics();
    await worker?.close();
    if (live) {
      result.liveRaw = live.history;
      await live.close();
    }
    await f.close();
  }
}
let pg;
try {
  const built =
    process.env.CANTRIP_RUST_SERVER_BINARY ??
    (await buildRustExample("http-sql-fixture"));
  const executable = path.join(
    root,
    "cantrip-server-fixture" + (process.platform === "win32" ? ".exe" : ""),
  );
  await copyFile(built, executable);
  report.executable = executable;
  report.executableSha256 = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex");
  const passwordHash = await hashPassword(password);
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of values.profile
    ? [values.profile]
    : ["none", "password", "accounts"]) {
    const runtimes = [];
    report.profiles.push({ profile, runtimes });
    for (const kind of ["node", "rust"]) {
      process.stderr.write(
        JSON.stringify({
          event: "project-export.http.started",
          profile,
          kind,
          database: values.database,
        }) + "\n",
      );
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
      await run(f, profile, result);
      process.stderr.write(
        JSON.stringify({
          event: "project-export.http.completed",
          profile,
          kind,
          cases: result.cases.length,
        }) + "\n",
      );
    }
    assert.deepEqual(
      runtimes[1].http,
      runtimes[0].http,
      profile + " full HTTP response contracts",
    );
    const comparable = (r) =>
      r.cases.map(({ rawStatePath, ...value }) => value);
    assert.deepEqual(
      comparable(runtimes[1]),
      comparable(runtimes[0]),
      profile + " exact worker commands, canonical bytes and Live events",
    );
    assert.deepEqual(
      runtimes[1].disconnectedCaller,
      runtimes[0].disconnectedCaller,
      profile + " full operation continues after actual caller destruction",
    );
    if (values.lifecycle) {
      const summary = (r) => ({
        response: r.shutdown.response,
        commands: r.shutdown.commands,
        exitCode: r.shutdown.exitCode,
        retry: r.shutdown.retry,
      });
      assert.deepEqual(
        summary(runtimes[1]),
        summary(runtimes[0]),
        profile + " interrupted server shutdown and post-restart receipt reuse",
      );
    }
    const normalize = (f, raw) =>
      JSON.parse(JSON.stringify(raw).replaceAll(f, "<owner>"));
    // Owner identities are generated by registration, and are related to each
    // fixture's actual session. Normalize only that single proven identity.
    for (let i = 0; i < runtimes[0].cases.length; i++) {
      const left = JSON.parse(
          await readFile(runtimes[0].cases[i].rawStatePath, "utf8"),
        ),
        right = JSON.parse(
          await readFile(runtimes[1].cases[i].rawStatePath, "utf8"),
        );
      const owner = (v) => v.projects.find((p) => p.id === project).owner_id;
      assert.deepEqual(
        normalize(owner(right), right),
        normalize(owner(left), left),
        profile + " complete unchanged SQL state " + i,
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
  } catch (error) {
    report.passed = false;
    report.postgresShutdownFailure = error.stack;
    throw error;
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
