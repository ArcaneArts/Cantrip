import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as crypto from "../../packages/crypto/dist/index.js";
import { discoveryWireFixtures } from "../server-rust/discovery-wire-fixtures.mjs";
import { projectLabel } from "../server-rust/security-fixtures.mjs";

export async function createPreparedProjectChat({
  call,
  eventually,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  title,
}) {
  const workspaceId = randomUUID();
  const { nameProtection } =
    discoveryWireFixtures(projectLabel)
      .encryptedProjectWorkspaceCreateSchema[0];
  await call("POST", "/api/workspaces", 201, {
    id: workspaceId,
    nameProtection,
    storage: { kind: "managed" },
  });
  const label = (recordKind, rowId, title) =>
    crypto.encryptPrivateDisplayLabel({
      ownerId,
      keyRevision,
      recordKind,
      rowId,
      componentKey: labelKey,
      label: title,
    });
  const projectId = randomUUID();
  const projectUrl = `/api/projects/${projectId}`;
  await call("POST", "/api/projects/from-folder", 202, {
    id: projectId,
    workerId,
    workspaceId,
    nameProtection: await label("project", projectId, "Interaction fixture"),
  });
  await eventually(
    () => call("GET", `${projectUrl}/folder-setup`, 200),
    (row) => assert.equal(row.state, "succeeded", JSON.stringify(row)),
  );
  const chatId = randomUUID();
  await call("POST", `${projectUrl}/chats`, 201, {
    id: chatId,
    titleProtection: await label("chat", chatId, title),
    autoTitle: false,
  });
  await eventually(
    () => call("GET", `/api/chats/${chatId}/preparation`, 200),
    ({ preparation }) =>
      assert.equal(preparation?.phase, "ready", JSON.stringify(preparation)),
    35_000,
  );
  return { chatId, chatUrl: `/api/chats/${chatId}` };
}

export async function verifyConsoleInteraction({
  call,
  eventually,
  createModel,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  interactionKey,
  prompt,
  marker,
  socketFile,
}) {
  const model = await createModel("Managed console approval model");
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: model.profile.id,
    autoNameChats: false,
  });
  const { chatId } = await createPreparedProjectChat({
    call,
    eventually,
    ownerId,
    workerId,
    keyRevision,
    labelKey,
    title: "Console approvals",
  });
  const url = await eventually(
    () => readFile(socketFile, "utf8"),
    (value) => assert.ok(value.startsWith("ws://127.0.0.1:")),
  );

  const { WebSocket } = createRequire(
    new URL("../../cantrip_worker/package.json", import.meta.url),
  )("ws");
  const sockets = [];
  const connect = async () => {
    const socket = new WebSocket(url.trim());
    sockets.push(socket);
    const frames = [];
    socket.on("message", (raw) => frames.push(JSON.parse(String(raw))));
    await once(socket, "open");
    const read = (match) =>
      eventually(
        () => frames.find(match),
        (frame) => assert.ok(frame),
      );
    const request = (id, method, params) => {
      socket.send(JSON.stringify({ id, method, params }));
      return read((frame) => frame.id === id && !frame.method);
    };
    const initialized = await request(1, "initialize", {
      clientInfo: { name: "cantrip-fixture", version: "0" },
      capabilities: { experimentalApi: true },
    });
    assert.equal(
      initialized.result?.cantripManagedGateway?.replyMethod,
      "cantrip/managed/reply",
      JSON.stringify(initialized),
    );
    socket.send(JSON.stringify({ method: "initialized" }));
    return {
      request,
      read,
      frames,
      threadId: initialized.result.cantripManagedGateway.threadId,
    };
  };
  const answer = model.model.reply({
    text: "Console interaction completed.",
    hold: true,
  });
  try {
    const view = await connect();
    const other = await connect();
    const threadId = view.threadId;
    const resumed = await view.request(2, "thread/resume", { threadId });
    assert.equal(resumed.result?.thread?.id, threadId, JSON.stringify(resumed));
    const started = await view.request(3, "turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });
    assert.ok(started.result?.turn?.id, JSON.stringify(started));
    const approval = await view.read(
      (frame) => frame.method === "item/commandExecution/requestApproval",
    );
    assert.equal(approval.params.turnId, started.result.turn.id);
    assert.equal(approval.params.threadId, threadId);
    const requests = `/api/agent-requests?chatId=${chatId}`;
    const [pending] = await eventually(
      () => call("GET", requests, 200),
      (rows) => {
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, "pending");
      },
    );
    assert.ok(!JSON.stringify(pending).includes("private fixture approval"));
    const reply = { requestId: approval.id, result: { decision: "decline" } };
    const foreign = await other.request(2, "cantrip/managed/reply", reply);
    assert.ok(foreign.error, JSON.stringify(foreign));
    assert.equal(
      other.frames.some((frame) => frame.id === approval.id),
      false,
    );
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    const bad = await view.request(4, "cantrip/managed/reply", {
      ...reply,
      error: { code: -32000, message: "fixture" },
    });
    assert.ok(bad.error, JSON.stringify(bad));
    const delivered = await view.request(5, "cantrip/managed/reply", reply);
    assert.equal(delivered.result?.delivered, true, JSON.stringify(delivered));
    assert.ok(delivered.result.operationGeneration);
    await view.read(
      (frame) =>
        frame.method === "serverRequest/resolved" &&
        frame.params.requestId === approval.id,
    );
    const replay = await view.request(6, "cantrip/managed/reply", reply);
    assert.ok(replay.error, JSON.stringify(replay));
    await eventually(
      () => readFile(marker, "utf8"),
      (text) => {
        assert.deepEqual(text.trim().split("\n").map(JSON.parse), [
          { id: approval.id, result: { decision: "decline" } },
        ]);
      },
    );
    const settled = await eventually(
      () => call("GET", `/api/agent-requests/${pending.id}`, 200),
      (row) => {
        assert.equal(row.status, "resolved");
        assert.ok(row.protectedResponse);
      },
    );
    const opened = await crypto.decryptInteractionResponseContent({
      ownerId,
      keyRevision,
      componentKey: interactionKey,
      requestKey: pending.requestKey,
      encrypted: settled.protectedResponse,
      publicClassification: pending.classification,
    });
    assert.equal(opened.response.decision, "decline");
    answer.release();
    await view.read(
      (frame) =>
        frame.method === "turn/completed" &&
        frame.params.turn.id === started.result.turn.id,
    );
    assert.deepEqual(model.model.failures, []);
    console.log(
      "Attached console delivered one admitted approval response and Core stored it encrypted.",
    );
  } finally {
    answer.release();
    for (const socket of sockets) socket.terminate();
  }
}
