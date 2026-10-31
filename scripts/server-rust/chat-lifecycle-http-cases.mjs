import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import {
  targetStateSql,
  label,
  json,
  literal,
  stamp,
} from "./project-target-state.mjs";
import { LiveProbe } from "./live-sockets.mjs";

export function chatLifecycleProjectSeedSql(owner) {
  const sql = targetStateSql(owner);
  for (const [id, experience, messages] of [
    ["project-history", "agent", true],
    ["project-running", "agent", false],
    ["project-approval", "agent", false],
    ["project-task", "task", true],
  ]) {
    sql.push(
      `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,status,experience,created_at,updated_at) VALUES(${literal(id)},${literal(owner)},'github','github-alpha-main','alpha',${json(label("chat"))},'idle',${literal(experience)},${literal(stamp)},${literal(stamp)})`,
    );
    if (messages)
      sql.push(
        `INSERT INTO chat_messages(id,chat_id,worktree_id,role,content) VALUES(${literal("message-" + id)},${literal(id)},'github-alpha-main','user','[]')`,
      );
  }
  return sql;
}
export async function chatLifecycleProjectHttpCases({
  fixture,
  visit,
  result,
  profile,
  titleProtection,
  projectControl,
}) {
  const live = await new LiveProbe(fixture).open();
  try {
    await live.initialized();
    await live.subscribed("project-lifecycle", [
      { kind: "current-user" },
      { kind: "project", projectId: "github" },
    ]);
    const base = "/api/chats/chat";
    await visit(
      "project runtime selection",
      "GET",
      base + "/runtime-selection",
    );
    await visit("project encrypted title", "PATCH", base, {
      json: { titleProtection },
    });
    await visit("project opaque composer", "PUT", base + "/composer-draft", {
      json: { state: { protectedContent: opaque } },
    });
    await visit(
      "project completion acknowledgement",
      "POST",
      base + "/completion/read",
    );
    await visit(
      "project files unavailable",
      "POST",
      base + "/files/operation",
      {
        status: 409,
        json: {
          operationId: "project-file",
          sequence: 0,
          protectedRequest: opaque,
          intent: "read",
        },
      },
    );
    // Startup recovers persisted running Chats. Establish these states after
    // startup on the disposable external store; repository probes cover all
    // three backends without reopening PGlite under a live server process.
    for (const [id, status] of projectControl
      ? [
          ["project-running", "running"],
          ["project-approval", "waiting-for-approval"],
        ]
      : []) {
      const changed =
        await projectControl`UPDATE chats SET status=${status} WHERE id=${id} RETURNING status`;
      assert.deepEqual(
        changed.map((r) => r.status),
        [status],
      );
      await visit(
        "project explicit archive blocked " + id,
        "POST",
        "/api/chats/" + id + "/archive",
        { status: 409 },
      );
      await visit(
        "project legacy delete blocked " + id,
        "DELETE",
        "/api/chats/" + id,
        { status: 409 },
      );
      await projectControl`UPDATE chats SET status='idle' WHERE id=${id}`;
    }
    await visit(
      "explicit archive empty project agent",
      "POST",
      base + "/archive",
      { status: 204 },
    );
    await visit("explicit archive is idempotent", "POST", base + "/archive", {
      status: 204,
    });
    await visit(
      "restore archived agent without placement",
      "POST",
      base + "/restore",
      { json: { attachToTabLayout: false } },
    );
    await visit(
      "active agent restore without placement",
      "POST",
      base + "/restore",
      { json: { attachToTabLayout: false } },
    );
    await visit(
      "active project default restore absent",
      "POST",
      base + "/restore",
      { status: 404, json: {} },
    );
    await visit("archive again for placement", "POST", base + "/archive", {
      status: 204,
    });
    await visit("restore into legacy placement", "POST", base + "/restore", {
      json: {},
    });
    await visit("delete empty project agent", "DELETE", base, { status: 204 });
    await visit(
      "deleted project agent absent",
      "GET",
      base + "/runtime-selection",
      { status: 404 },
    );
    await visit(
      "project history legacy archive",
      "DELETE",
      "/api/chats/project-history",
      { status: 204 },
    );
    await visit(
      "project history permanent deletion",
      "DELETE",
      "/api/chats/project-history/permanent",
      { status: 204 },
    );
    await visit(
      "project permanent deletion repeat",
      "DELETE",
      "/api/chats/project-history/permanent",
      { status: 404 },
    );
    await visit(
      "explicit archive excludes project task",
      "POST",
      "/api/chats/project-task/archive",
      { status: 404 },
    );
    await visit(
      "legacy archive project task",
      "DELETE",
      "/api/chats/project-task",
      { status: 204 },
    );
    await visit(
      "restore project task without placement",
      "POST",
      "/api/chats/project-task/restore",
      { json: {} },
    );
    if (profile === "accounts")
      await visit(
        "foreign project archive",
        "POST",
        "/api/chats/project-task/archive",
        { client: "other", status: 404 },
      );
    await live.ping("project lifecycle done");
    result.rawProjectEvents = live.history.filter((e) => e.type === "event");
    assert.ok(
      result.rawProjectEvents.some(
        (e) => e.resource === "chat" && e.scope.kind === "project",
      ),
      "completion retains its project scope",
    );
    result.projectEvents = result.rawProjectEvents.map(
      ({ scope, resource, action, entityId, revision, payload }) =>
        fixture.normalize({
          scope,
          resource,
          action,
          entityId,
          revision,
          payload,
        }),
    );
  } finally {
    await live.close();
  }
}
const opaque = {
  formatVersion: 1,
  keyRevision: 1,
  envelope: {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    nonce: "A".repeat(16),
    ciphertext: "A".repeat(43),
  },
};
export async function chatLifecycleWorkerResult({
  command,
  result,
  modes,
  fixture,
  gates,
}) {
  if (
    ![
      "chat.scratch.archive",
      "chat.scratch.restore",
      "chat.scratch.delete",
      "chat.files.references",
      "chat.scratch.files.operation",
    ].includes(command.type)
  )
    throw new Error("Controlled metadata command is unsupported");
  result.lifecycleCommands.push(command);
  if (
    command.type === "chat.scratch.archive" &&
    modes.get("archive") === "held"
  )
    await new Promise((resolve) =>
      gates.set("archive:" + command.chatId, resolve),
    );
  if (command.type === "chat.scratch.archive") {
    assert.equal(
      Date.parse(command.archiveExpiresAt) - Date.parse(command.archivedAt),
      90 * 86400000,
    );
    fixture.chatArchiveExpirations.add(command.archiveExpiresAt);
  }
  const mode = modes.get("lifecycle");
  if (mode === "error") throw new Error("Controlled Chat lifecycle failure");
  if (mode === "invalid") return { invalid: true };
  if (command.type === "chat.scratch.archive") {
    assert.equal(
      Date.parse(command.archiveExpiresAt) - Date.parse(command.archivedAt),
      90 * 86400000,
    );
    fixture.chatArchiveExpirations.add(command.archiveExpiresAt);
    return {
      rootId: command.rootId,
      chatId: command.chatId,
      archivedAt: command.archivedAt,
      archiveExpiresAt: command.archiveExpiresAt,
    };
  }
  if (command.type === "chat.scratch.restore")
    return {
      rootId: command.rootId,
      chatId: command.chatId,
      archivedAt: null,
      archiveExpiresAt: null,
    };
  if (command.type === "chat.scratch.delete") {
    if (modes.get("delete") === "held")
      await new Promise((resolve) =>
        gates.set("delete:" + command.chatId, resolve),
      );
    return {
      rootId: command.rootId,
      chatId: command.chatId,
      jobId: command.jobId,
      attempt: command.attempt,
      deleted: true,
    };
  }
  if (
    ["chat.files.references", "chat.scratch.files.operation"].includes(
      command.type,
    )
  )
    return {
      operationId: command.operationId,
      sequence: command.sequence,
      protectedResponse: command.protectedRequest,
    };
  throw new Error("Controlled metadata command is unsupported");
}
export async function chatLifecycleHttpCases({
  fixture,
  visit,
  result,
  live,
  foreign,
  worker,
  modes,
  gates,
  until,
  ids,
  workerId,
  profile,
  titleProtection,
}) {
  const id = ids[0],
    base = "/api/chats/" + id;
  const rawEvents = () => live.history.filter((e) => e.type === "event");
  const count = () => rawEvents().filter((e) => e.resource === "chat").length;
  await live.subscribed("lifecycle-chat", [
    { kind: "current-user" },
    { kind: "chat", chatId: id },
  ]);
  const before = count();
  for (const route of ["runtime-selection", "composer-draft"]) {
    await visit("lifecycle read " + route, "GET", base + "/" + route);
    await visit("lifecycle HEAD " + route, "HEAD", base + "/" + route, {
      compareContentLength: true,
    });
  }
  for (const input of [
    null,
    {},
    [],
    { titleProtection },
    { titleProtection, extra: 1 },
  ]) {
    if (input?.titleProtection && !input.extra) continue;
    await visit("invalid title " + JSON.stringify(input), "PATCH", base, {
      status: 400,
      json: input,
    });
  }
  await visit("update encrypted title", "PATCH", base, {
    json: { titleProtection },
  });
  for (const input of [{}, false, { state: {} }, { state: null, extra: 1 }])
    await visit(
      "invalid draft " + JSON.stringify(input),
      "PUT",
      base + "/composer-draft",
      { status: 400, json: input },
    );
  const state = { protectedContent: opaque };
  await visit("store composer ciphertext", "PUT", base + "/composer-draft", {
    json: { state },
  });
  assert.deepEqual(
    (await visit("read composer ciphertext", "GET", base + "/composer-draft"))
      .state,
    state,
  );
  await visit("clear composer ciphertext", "PUT", base + "/composer-draft", {
    json: { state: null },
  });
  await visit("completion acknowledged", "POST", base + "/completion/read");
  await live.ping("metadata boundaries");
  assert.equal(
    count(),
    before + 3,
    "title response and completion's direct/response publications",
  );
  const wire = {
    operationId: "lifecycle-file-operation",
    sequence: 5,
    protectedRequest: opaque,
  };
  await visit("file references", "POST", base + "/file-references", {
    json: wire,
  });
  for (const intent of ["read", "write", "remove"]) {
    await visit("opaque file " + intent, "POST", base + "/files/operation", {
      json: { ...wire, intent },
    });
  }
  await visit(
    "stale file placement rejected",
    "POST",
    base + "/files/operation",
    {
      status: 409,
      json: {
        ...wire,
        intent: "write",
        binding: { workerId: "another-worker", scratchRootId: ids[11] },
      },
    },
  );
  for (const mode of ["error", "invalid"]) {
    modes.set("lifecycle", mode);
    await visit("file worker " + mode, "POST", base + "/files/operation", {
      status: 502,
      json: { ...wire, intent: "write" },
    });
  }
  modes.delete("lifecycle");
  for (const input of [{ attachToTabLayout: "false" }, { extra: 1 }, [], false])
    await visit(
      "invalid restore " + JSON.stringify(input),
      "POST",
      base + "/restore",
      { status: 400, json: input },
    );
  await visit("archive route excludes standalone", "POST", base + "/archive", {
    status: 404,
  });
  if (profile === "accounts") {
    for (const [method, suffix, json] of [
      ["PATCH", "", { titleProtection }],
      ["PUT", "/composer-draft", { state }],
      ["GET", "/composer-draft"],
      ["POST", "/completion/read"],
      ["POST", "/file-references", wire],
      ["POST", "/files/operation", { ...wire, intent: "read" }],
      ["DELETE", ""],
      ["POST", "/restore", {}],
      ["DELETE", "/permanent"],
    ])
      await visit(
        "foreign lifecycle " + method + suffix,
        method,
        base + suffix,
        {
          client: "other",
          status: 404,
          ...(json === undefined ? {} : { json }),
        },
      );
  }
  await visit("archive active standalone", "DELETE", base, { status: 204 });
  const archived = await visit(
    "archived Chat catalog",
    "GET",
    "/api/chats/archived?context=standalone",
  );
  assert.equal(archived.length, 1);
  assert.equal(archived[0].id, id);
  for (const [method, suffix, json] of [
    ["GET", "/runtime-selection"],
    ["GET", "/composer-draft"],
    ["PATCH", "", { titleProtection }],
    ["PUT", "/composer-draft", { state }],
    ["POST", "/file-references", wire],
    ["POST", "/files/operation", { ...wire, intent: "read" }],
    ["DELETE", ""],
  ])
    await visit("archived absent " + method + suffix, method, base + suffix, {
      status: 404,
      ...(json === undefined ? {} : { json }),
    });
  await visit("archived completion read", "POST", base + "/completion/read");
  await visit(
    "restore standalone ignores project placement",
    "POST",
    base + "/restore",
    { json: { attachToTabLayout: false } },
  );
  await visit("active standalone restore absent", "POST", base + "/restore", {
    status: 404,
  });
  for (const mode of ["error", "invalid"]) {
    modes.set("lifecycle", mode);
    await visit("archive survives worker " + mode, "DELETE", base, {
      status: 204,
    });
    await visit("restore survives worker " + mode, "POST", base + "/restore", {
      json: null,
    });
  }
  modes.delete("lifecycle");
  const extra = ids[10];
  await visit("create deletion candidate", "POST", "/api/chats", {
    status: 202,
    json: { id: extra, titleProtection },
  });
  await until(
    () => gates.has(extra),
    (v) => assert.equal(v, true),
  );
  gates.get(extra)();
  gates.delete(extra);
  await until(
    () =>
      rawEvents().filter((e) => e.resource === "chat" && e.entityId === extra)
        .length,
    (n) => assert.equal(n, 2),
  );
  await visit(
    "active permanent deletion refused",
    "DELETE",
    "/api/chats/" + extra + "/permanent",
    { status: 404 },
  );
  await visit("archive deletion candidate", "DELETE", "/api/chats/" + extra, {
    status: 204,
  });
  modes.set("delete", "held");
  await visit(
    "durable permanent deletion",
    "DELETE",
    "/api/chats/" + extra + "/permanent",
    { status: 204 },
  );
  await until(
    () => gates.has("delete:" + extra),
    (ready) => assert.equal(ready, true),
  );
  await live.ping("durable tombstone before delete completion");
  assert.equal(
    rawEvents().filter((e) => e.resource === "chat" && e.entityId === extra)
      .length,
    6,
  );
  gates.get("delete:" + extra)();
  gates.delete("delete:" + extra);
  await until(
    () =>
      rawEvents().filter((e) => e.resource === "chat" && e.entityId === extra)
        .length,
    (n) => assert.equal(n, 7),
  );
  await visit(
    "permanent repeat absent",
    "DELETE",
    "/api/chats/" + extra + "/permanent",
    { status: 404 },
  );
  // The worker command proves the database mutation was admitted. Disconnect
  // this caller while the worker is held, then inspect the surviving operation.
  const prior = count();
  let callerError, unexpectedResponse;
  modes.set("archive", "held");
  const caller = httpRequest(
    fixture.server.origin + base,
    {
      method: "DELETE",
      agent: false,
      headers: {
        origin: "http://127.0.0.1:5173",
        cookie: [...fixture.client().cookies]
          .map(([k, v]) => `${k}=${v}`)
          .join("; "),
        ...(fixture.client().csrf
          ? { "x-cantrip-csrf": fixture.client().csrf }
          : {}),
      },
    },
    (response) => {
      unexpectedResponse = response.statusCode;
      response.resume();
    },
  );
  caller.on("error", (error) => {
    callerError = error.message;
  });
  const closed = new Promise((resolve) => caller.once("close", resolve));
  caller.end();
  await until(
    () => gates.has("archive:" + id),
    (ready) => assert.equal(ready, true),
  );
  caller.destroy(new Error("Controlled lifecycle caller disconnect"));
  await closed;
  assert.equal(callerError, "Controlled lifecycle caller disconnect");
  assert.equal(unexpectedResponse, undefined);
  gates.get("archive:" + id)();
  gates.delete("archive:" + id);
  modes.delete("archive");
  await until(count, (n) => assert.equal(n, prior + 1));
  await visit(
    "archive survives disconnected HTTP caller",
    "POST",
    base + "/restore",
    { json: {} },
  );
  result.disconnectedArchive = {
    callerError,
    commandAdmitted: true,
    durableRestore: true,
  };
  worker.close();
  await until(
    async () => {
      const response = await fetch(fixture.server.origin + "/api/workers", {
        headers: {
          cookie: [...fixture.client().cookies]
            .map(([k, v]) => `${k}=${v}`)
            .join("; "),
        },
      });
      assert.equal(response.status, 200);
      return response.json();
    },
    (workers) =>
      assert.equal(workers.find((w) => w.workerId === workerId).online, false),
  );
  await visit("offline file operation", "POST", base + "/files/operation", {
    status: 503,
    json: { ...wire, intent: "read" },
  });
  await visit("offline references", "POST", base + "/file-references", {
    status: 503,
    json: wire,
  });
  await visit("offline archive", "DELETE", base, { status: 204 });
  await visit("offline restore", "POST", base + "/restore", { json: {} });
  await live.ping("lifecycle complete");
  result.rawFileEvents = rawEvents().filter((e) => e.resource === "chat-files");
  assert.equal(
    result.rawFileEvents.length,
    2,
    "only successful write/remove publish file invalidations",
  );
  result.fileEvents = result.rawFileEvents.map(
    ({ scope, resource, action, entityId, revision, payload }) =>
      fixture.normalize({
        scope,
        resource,
        action,
        entityId,
        revision,
        payload,
      }),
  );
  if (foreign) {
    await foreign.ping("lifecycle ownership");
    assert.equal(
      foreign.history.filter(
        (e) =>
          e.type === "event" && ["chat", "chat-files"].includes(e.resource),
      ).length,
      0,
    );
  }
}
