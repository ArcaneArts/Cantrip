// Real production HTTP/SQL and unchanged worker transport; no filesystem crypto
// acceptance claim. Each implementation uses a separate disposable database.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { attachmentWorker } from "./chat-attachment-http-worker.mjs";
import { attachmentFaults } from "./chat-attachment-http-faults.mjs";
import { attachmentReopen } from "./chat-attachment-http-reopen.mjs";
import {
  targetStateSql,
  localOwner,
  otherOwner,
  literal,
  json,
  stamp,
} from "./project-target-state.mjs";
import {
  protectedAttachmentMetadataFixture as metadata,
  protectedAttachmentChunkFixture as chunk,
} from "../../cantrip_server/test/protected-attachment-fixture.ts";
import { password } from "./security-fixtures.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    profile: { type: "string" },
    report: { type: "string" },
  },
});
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-chat-attachment-http-"),
);
process.stderr.write(
  JSON.stringify({ event: "chat-attachment.http.created", root }) + "\n",
);
const report = {
  root,
  database: values.database,
  profiles: [],
  completeReplacement: false,
  scope:
    "Real HTTP, SQL and unchanged WorkerConnection with controlled opaque attachment operations; supported-platform/product/crypto acceptance remains required",
};
const project = "11111111-1111-4111-8111-000000000001",
  operation = "33333333-3333-4333-8333-abcdefabcdef";
const sqlQuery =
  "SELECT jsonb_build_object('attachments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM chat_attachments a),'replicas',(SELECT jsonb_agg(to_jsonb(r) ORDER BY attachment_id,worker_id) FROM chat_attachment_replicas r))::text AS result";
async function run(f, profile, result) {
  const state = {
    commands: [],
    background: [],
    uploads: new Map(),
    heartbeatFailures: [],
  };
  const workers = [];
  let owner;
  const evidence = path.join(root, profile, f.kind, "observations");
  await mkdir(evidence, { recursive: true });
  const visit = async (name, method, url, options = {}) => {
    result.http.push({
      name,
      ...(await f.observe(name, method, url, { csrf: true, ...options })),
    });
    return f.records.get(name);
  };
  const snapshot = async () => (await f.sql([], [sqlQuery]))[0];
  let serial = 0;
  const input = (sizeBytes = 3) => {
    const id = "44444444-4444-4444-8444-" + String(++serial).padStart(12, "0");
    const chunks = [];
    let left = sizeBytes;
    do {
      const count = Math.min(left, 262144);
      chunks.push(
        chunk({
          sequence: chunks.length,
          plaintextBytes: count,
          eof: left === count,
        }),
      );
      left -= count;
    } while (left);
    return {
      attachmentId: id,
      operationId: operation,
      sizeBytes,
      protectedMetadata: metadata(id),
      chunks,
    };
  };
  const settle = async (name, method, url, options = {}, mutation) => {
    const before = await snapshot(),
      offset = state.commands.length;
    const response = await visit(name, method, url, options);
    const after = await snapshot();
    if (mutation) await mutation(before, after, response);
    else
      assert.deepEqual(
        after,
        before,
        name + " leaves every attachment/replica row unchanged",
      );
    const rawStatePath = path.join(
      evidence,
      String(result.cases.length).padStart(3, "0") + ".json",
    );
    await writeFile(rawStatePath, JSON.stringify(after, null, 2) + "\n");
    // WorkerConnection resolves transport correlation before invoking its
    // command handler; the handler receives the operation body without an ID.
    const commands = state.commands.slice(offset);
    // Separate worker connections have no cross-worker ordering guarantee.
    // Preserve per-worker stream order; only parallel deletion is sorted.
    if (method === "DELETE")
      commands.sort((a, b) => a.worker.localeCompare(b.worker));
    result.cases.push({ name, commands, rawStatePath });
    return response;
  };
  const upload = (name, body, options = {}, mutation) =>
    settle(
      name,
      "POST",
      "/api/chats/chat/attachments",
      {
        status: 201,
        raw: JSON.stringify(body),
        headers: { "content-type": "application/octet-stream" },
        ...options,
      },
      mutation,
    );
  const created = (body) => (before, after, response) => {
    assert.equal(response.id, body.attachmentId);
    assert.equal(response.chatId, "chat");
    assert.equal(response.sizeBytes, body.sizeBytes);
    assert.deepEqual(response.protectedMetadata, body.protectedMetadata);
    assert.equal(response.status, "ready");
    assert.equal("workerId" in response, false);
    const old = before.attachments ?? [],
      rows = after.attachments ?? [];
    assert.equal(rows.length, old.length + 1);
    for (const row of old)
      assert.deepEqual(
        rows.find((r) => r.id === row.id),
        row,
      );
    const row = rows.find((r) => r.id === body.attachmentId);
    assert.equal(row.worker_id, "alpha");
    assert.equal(row.chat_id, "chat");
    assert.equal(row.size_bytes, body.sizeBytes);
    assert.deepEqual(row.protected_metadata, body.protectedMetadata);
    assert.equal(row.status, "ready");
    assert.equal(new Date(row.created_at).toISOString(), response.createdAt);
    const replica = after.replicas.find(
      (r) => r.attachment_id === body.attachmentId,
    );
    assert.equal(replica.worker_id, "alpha");
    assert.equal(replica.status, "ready");
    assert.equal(after.replicas.length, (before.replicas ?? []).length + 1);
  };
  const download = (name, id, options = {}) =>
    settle(
      name,
      "GET",
      `/api/attachments/${id}/content?operationId=${operation}`,
      options,
    );
  try {
    await f.start();
    const authName =
      profile === "accounts"
        ? "register"
        : profile === "password"
          ? "login"
          : "session";
    const auth =
      profile === "accounts"
        ? await visit(authName, "POST", "/api/auth/register", {
            status: 201,
            json: {
              email: "attachment@example.invalid",
              displayName: "Attachment",
              password,
            },
          })
        : profile === "password"
          ? await visit(authName, "POST", "/api/auth/login", {
              json: { password },
            })
          : await visit(authName, "GET", "/api/auth/session");
    owner = auth.currentUser?.id ?? localOwner;
    result.owner = owner;
    for (const id of ["alpha", "beta"])
      workers.push(
        await attachmentWorker({
          f,
          visit,
          root: path.join(root, profile, f.kind),
          state,
          id,
        }),
      );
    await f.sql(
      targetStateSql(owner, otherOwner, { github: project }).filter(
        (sql) => !/^INSERT INTO workers.*VALUES\('(alpha|beta)'/.test(sql),
      ),
    );
    await settle(
      "missing upload Chat",
      "POST",
      "/api/chats/missing/attachments",
      {
        status: 404,
        raw: "invalid",
        headers: { "content-type": "application/octet-stream" },
      },
    );
    await settle(
      "foreign upload Chat",
      "POST",
      "/api/chats/other-chat/attachments",
      {
        status: 404,
        raw: "invalid",
        headers: { "content-type": "application/octet-stream" },
      },
    );
    await f.sql(["UPDATE chats SET archived_at=now() WHERE id='chat'"]);
    await upload("archived upload Chat", input(), { status: 404 });
    await f.sql(["UPDATE chats SET archived_at=NULL WHERE id='chat'"]);
    for (const [name, options] of [
      ["malformed binary JSON", { raw: "invalid", status: 400 }],
      ["empty binary", { raw: "", status: 400 }],
      ["binary BOM", { raw: "\ufeff" + JSON.stringify(input()), status: 400 }],
      [
        "JSON upload media",
        {
          raw: JSON.stringify(input()),
          headers: { "content-type": "application/json" },
          status: 400,
        },
      ],
      [
        "malformed JSON media",
        {
          raw: "{",
          headers: { "content-type": "application/json" },
          status: 400,
        },
      ],
      [
        "text upload media",
        {
          raw: JSON.stringify(input()),
          headers: { "content-type": "text/plain" },
          status: 400,
        },
      ],
      [
        "unsupported media",
        { raw: "hello", headers: { "content-type": "image/png" }, status: 415 },
      ],
    ])
      await upload(name, input(), options);
    for (const mutate of [
      (b) => {
        b.extra = true;
      },
      (b) => {
        b.chunks[0].sequence = 1;
      },
      (b) => {
        b.chunks[0].eof = false;
      },
      (b) => {
        b.sizeBytes = 4;
      },
      (b) => {
        b.protectedMetadata.envelope.keyRevision = 2;
      },
    ]) {
      const b = input();
      mutate(b);
      await upload("invalid stream " + serial, b, { status: 400 });
    }
    const empty = input(0);
    await upload("empty opaque upload", empty, {}, created(empty));
    await download("empty content", empty.attachmentId);
    const large = input(600000);
    await upload("three ordered opaque chunks", large, {}, created(large));
    const got = await download("three chunk content", large.attachmentId);
    assert.deepEqual(got, { ...large });
    await f.sql(["UPDATE chats SET archived_at=now() WHERE id='chat'"]);
    await download(
      "archived Chat content remains readable",
      large.attachmentId,
    );
    await f.sql([
      "UPDATE chats SET archived_at=NULL WHERE id='chat'",
      `INSERT INTO chat_attachments(id,chat_id,worker_id,size_bytes,protected_metadata) VALUES('foreign-attachment','other-chat','foreign',3,${json(metadata("foreign"))})`,
    ]);
    await download("foreign attachment content", "foreign-attachment", {
      status: 404,
    });
    await settle(
      "foreign attachment delete",
      "DELETE",
      "/api/attachments/foreign-attachment",
      { status: 404 },
    );
    await upload("duplicate receipt", large, { status: 409 });
    await settle(
      "missing attachment",
      "GET",
      `/api/attachments/missing/content?operationId=${operation}`,
      { status: 404 },
    );
    await settle(
      "missing operation",
      "GET",
      `/api/attachments/${large.attachmentId}/content`,
      { status: 400 },
    );
    await settle(
      "duplicate operation query",
      "GET",
      `/api/attachments/${large.attachmentId}/content?operationId=${operation}&operationId=${operation}`,
      { status: 500 },
    );
    await settle(
      "trimmed uppercase UUID",
      "GET",
      `/api/attachments/${large.attachmentId}/content?operationId=%20${operation.toUpperCase()}%20`,
    );
    await f.sql([
      `UPDATE chat_attachments SET status='failed' WHERE id=${literal(large.attachmentId)}`,
    ]);
    await download("failed before operation validation", large.attachmentId, {
      status: 409,
    });
    await f.sql([
      `UPDATE chat_attachments SET status='ready' WHERE id=${literal(large.attachmentId)}`,
    ]);
    for (const type of [
      "attachment.upload.begin",
      "attachment.upload.chunk",
      "attachment.upload.complete",
    ]) {
      state.failType = type;
      await upload("compensation after " + type, input(), { status: 502 });
      delete state.failType;
      assert.equal(
        result.cases.at(-1).commands.at(-1).command.type,
        "attachment.delete",
      );
    }
    state.uploadResult = { sizeBytes: 99, verified: true };
    await upload("wrong upload result size", input(), { status: 502 });
    delete state.uploadResult;
    state.uploadResult = { sizeBytes: 3, verified: false };
    await upload("unverified upload result", input(), { status: 502 });
    delete state.uploadResult;
    const failures = [
      [
        "wrong read total",
        (command, u) => ({ sizeBytes: u.sizeBytes + 1, chunk: u.chunks[0] }),
      ],
      [
        "wrong sequence",
        (command, u) => ({
          sizeBytes: u.sizeBytes,
          chunk: { ...u.chunks[0], sequence: 1 },
        }),
      ],
      [
        "truncated EOF",
        (command, u) => ({
          sizeBytes: u.sizeBytes,
          chunk: { ...u.chunks[0], eof: true },
        }),
      ],
      [
        "empty read",
        (command, u) => ({
          sizeBytes: u.sizeBytes,
          chunk: { ...u.chunks[0], plaintextBytes: 0, eof: false },
        }),
      ],
      [
        "unterminated read",
        (command, u) => ({
          sizeBytes: u.sizeBytes,
          chunk: { ...u.chunks[command.sequence], eof: false },
        }),
      ],
      [
        "invalid protected read",
        (command, u) => ({
          sizeBytes: u.sizeBytes,
          chunk: { ...u.chunks[0], envelope: null },
        }),
      ],
    ];
    for (const [name, read] of failures) {
      state.readResult = read;
      await download(name, large.attachmentId, { status: 502 });
      delete state.readResult;
    }
    await attachmentFaults({
      f,
      state,
      input,
      visit,
      snapshot,
      evidence,
      result,
    });
    await f.sql([
      `INSERT INTO chat_attachment_replicas(attachment_id,worker_id,status) VALUES(${literal(large.attachmentId)},'beta','ready')`,
    ]);
    state.uploads.set(
      "beta:" + large.attachmentId,
      structuredClone(state.uploads.get("alpha:" + large.attachmentId)),
    );
    await workers[0].close();
    await download("ready replica fallback", large.attachmentId);
    assert.ok(result.cases.at(-1).commands.every((c) => c.worker === "beta"));
    await f.sql([
      `UPDATE chat_attachment_replicas SET status='pending' WHERE attachment_id=${literal(large.attachmentId)} AND worker_id='beta'`,
    ]);
    await download("pending replica unavailable", large.attachmentId, {
      status: 503,
    });
    await f.sql([
      `UPDATE chat_attachment_replicas SET status='ready' WHERE attachment_id=${literal(large.attachmentId)} AND worker_id='beta'`,
    ]);
    await workers[0].start();
    state.failType = "attachment.delete";
    state.failWorker = "alpha";
    await settle(
      "failed delete retains SQL",
      "DELETE",
      "/api/attachments/" + large.attachmentId,
      { status: 500 },
    );
    delete state.failType;
    delete state.failWorker;
    await settle(
      "delete all connected replicas",
      "DELETE",
      "/api/attachments/" + large.attachmentId,
      { status: 204 },
      (before, after) => {
        assert.equal(after.attachments.length, before.attachments.length - 1);
        assert.equal(
          after.attachments.some((a) => a.id === large.attachmentId),
          false,
        );
        assert.equal(
          after.replicas.some((a) => a.attachment_id === large.attachmentId),
          false,
        );
      },
    );
    await settle(
      "deleted attachment",
      "DELETE",
      "/api/attachments/" + large.attachmentId,
      { status: 404 },
    );
    await upload("upload byte quota before dispatch", input(700000), {
      status: 429,
      fetcher: async (...args) => {
        const response = await fetch(...args);
        const retry = response.headers.get("retry-after");
        assert.match(retry, /^[1-9]\d*$/);
        assert.ok(+retry <= 60);
        result.quotaRetryAfterSeconds = +retry;
        return response;
      },
    });
    assert.equal(result.cases.at(-1).commands.length, 0);
    await attachmentReopen({
      f,
      workers,
      attachmentId: empty.attachmentId,
      snapshot,
      result,
      settle,
      upload,
      input,
    });
    result.passed = true;
  } finally {
    result.diagnostics = f.server?.diagnostics();
    result.heartbeatFailures = state.heartbeatFailures;
    for (const worker of workers) await worker.close();
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
    "server-fixture" + (process.platform === "win32" ? ".exe" : ""),
  );
  await copyFile(built, executable);
  report.executable = executable;
  report.executableSha256 = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex");
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  const passwordHash = await hashPassword(password);
  for (const profile of values.profile
    ? [values.profile]
    : ["none", "password", "accounts"]) {
    const cell = { profile, runtimes: [] };
    report.profiles.push(cell);
    for (const kind of ["node", "rust"]) {
      process.stderr.write(
        JSON.stringify({
          event: "chat-attachment.http.started",
          database: values.database,
          profile,
          kind,
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
          PGLITE_RUNTIME_DIR: path.join(root, profile, kind, "pglite-runtime"),
          CANTRIP_FIXTURE_LOGGING: "true",
          CANTRIP_REGISTRATION_ENABLED: "true",
          CANTRIP_ACCOUNT_UPLOAD_BYTES_PER_MINUTE: "1048576",
          CANTRIP_WORKER_UPLOAD_BYTES_PER_MINUTE: "1048576",
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
      cell.runtimes.push(result);
      await run(f, profile, result);
    }
    assert.deepEqual(
      cell.runtimes[1].http,
      cell.runtimes[0].http,
      profile + " exact HTTP contracts",
    );
    const cases = (r) => r.cases.map(({ rawStatePath, ...value }) => value);
    assert.deepEqual(
      cases(cell.runtimes[1]),
      cases(cell.runtimes[0]),
      profile + " exact opaque worker requests",
    );
    assert.deepEqual(
      cell.runtimes[1].disconnectedCaller,
      cell.runtimes[0].disconnectedCaller,
      profile + " actual caller destruction retains the full upload",
    );
    const normalize = (value, owner) => {
      if (Array.isArray(value)) return value.map((v) => normalize(v, owner));
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => {
            if (
              ["created_at", "updated_at", "verified_at"].includes(k) &&
              v !== stamp
            ) {
              assert.ok(Number.isFinite(Date.parse(v)));
              assert.ok(Math.abs(Date.now() - Date.parse(v)) < 300000);
              return [k, "<generated-db-timestamp>"];
            }
            return [k, normalize(v, owner)];
          }),
        );
      return value === owner ? "<owner>" : value;
    };
    for (let i = 0; i < cell.runtimes[0].cases.length; i++) {
      const [left, right] = await Promise.all(
        cell.runtimes.map((r) =>
          readFile(r.cases[i].rawStatePath, "utf8").then(JSON.parse),
        ),
      );
      assert.deepEqual(
        normalize(right, cell.runtimes[1].owner),
        normalize(left, cell.runtimes[0].owner),
        profile + " complete paired SQL " + i,
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
