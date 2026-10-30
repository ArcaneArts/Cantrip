// Observe actual request UUIDs before the unchanged worker decodes each frame.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { createRequire } from "node:module";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { sendHeartbeat } from "../../cantrip_worker/src/heartbeat.ts";
import { heartbeat } from "./security-fixtures.mjs";
import { eventually } from "./full-worker.mjs";

const WebSocket = createRequire(
  new URL("../../cantrip_worker/package.json", import.meta.url),
)("ws");
const frames = [];
const emit = WebSocket.prototype.emit;
WebSocket.prototype.emit = function (event, ...args) {
  if (event === "message") {
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(args[0]).toString());
    } catch {}
    if (
      parsed?.kind === "request" &&
      parsed.command?.type?.startsWith("project.share.")
    )
      frames.push({
        socket: this,
        requestId: parsed.requestId,
        command: parsed.command,
        claimed: false,
      });
  }
  return Reflect.apply(emit, this, [event, ...args]);
};
export async function shareWorker({
  fixture,
  root,
  visit,
  result,
  id = "alpha",
  client = "main",
}) {
  const capabilities = (enabled) => ({
    ...heartbeat,
    workerId: id,
    standaloneChat: {
      ...heartbeat.standaloneChat,
      files: { ...heartbeat.standaloneChat.files, networkShare: enabled },
    },
  });
  await visit(
    "share enrollment code " + id,
    "POST",
    "/api/workers/enrollment-codes",
    { client, json: {}, status: 201 },
  );
  const enrolled = await visit(
    "share enroll " + id,
    "POST",
    "/api/internal/workers/enroll",
    {
      client: "worker",
      json: {
        code: fixture.records.get("share enrollment code " + id).code,
        heartbeat: capabilities(false),
      },
      status: 201,
    },
  );
  const config = {
    dataDirectory: path.join(root, id),
    name: "Controlled project-share worker",
    serverUrl: fixture.server.origin,
    enrollmentCode: null,
    replacement: null,
    token: enrolled.credential,
    tokenSource: "persisted",
    workerId: id,
  };
  saveWorkerCredential({
    credential: config.token,
    dataDirectory: config.dataDirectory,
    serverUrl: config.serverUrl,
    workerId: id,
  });
  const controller = { mode: "ok", closeMode: "ok", pending: [], socket: null };
  let connected = false;
  const connection = new WorkerConnection(
    config,
    async (command) => {
      if (!command.type.startsWith("project.share.")) return null;
      const frame = frames.find(
        (f) => !f.claimed && isDeepStrictEqual(f.command, command),
      );
      assert.ok(frame, "Observed the actual unchanged worker request envelope");
      frame.claimed = true;
      controller.socket = frame.socket;
      result.commands.push({
        workerId: id,
        requestId: frame.requestId,
        command,
      });
      const mode =
        command.type === "project.share.close"
          ? controller.closeMode
          : controller.mode;
      if (mode === "hold")
        return await new Promise((resolve) =>
          controller.pending.push(() =>
            resolve({ accepted: true, shareId: command.shareId }),
          ),
        );
      if (mode === "error")
        throw new Error("PRIVATE_SHARE_FAILURE /private/unlocked/root");
      if (mode === "coded-error")
        throw Object.assign(
          new Error("PRIVATE_SHARE_FAILURE /private/unlocked/root"),
          { code: "project-source-unavailable" },
        );
      if (mode === "other-code")
        throw Object.assign(
          new Error("PRIVATE_SHARE_FAILURE /private/unlocked/root"),
          { code: "permission-denied" },
        );
      if (mode === "invalid") return null;
      if (mode === "extra")
        return {
          accepted: true,
          shareId: command.shareId,
          privatePath: "PRIVATE_SHARE_FAILURE",
        };
      if (mode === "mismatch")
        return { accepted: true, shareId: "unexpected-share" };
      return { accepted: true, shareId: command.shareId };
    },
    undefined,
    undefined,
    undefined,
    1000,
    () => (connected = true),
  );
  controller.release = () => {
    for (const resolve of controller.pending.splice(0)) resolve();
  };
  controller.heartbeat = (enabled) =>
    sendHeartbeat(config, capabilities(enabled));
  controller.close = async () => {
    controller.release();
    const closed =
      controller.socket && controller.socket.readyState !== WebSocket.CLOSED
        ? new Promise((resolve) => controller.socket.once("close", resolve))
        : Promise.resolve();
    connection.close();
    await closed;
  };
  connection.start();
  await eventually(
    () => connected,
    (n) => assert.equal(n, true),
  );
  return controller;
}
