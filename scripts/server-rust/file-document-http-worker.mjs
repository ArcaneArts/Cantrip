// Unchanged worker transport; only this fixture's operation outcomes are controlled.
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { heartbeat } from "./security-fixtures.mjs";
import { fileDocumentWireFixtures } from "./file-document-wire-fixtures.mjs";
import { eventually } from "./full-worker.mjs";
const WebSocket = createRequire(
  new URL("../../cantrip_worker/package.json", import.meta.url),
)("ws");
const frames = [],
  emit = WebSocket.prototype.emit;
WebSocket.prototype.emit = function (event, ...args) {
  if (event === "message") {
    let value;
    try {
      value = JSON.parse(Buffer.from(args[0]).toString());
    } catch {}
    if (
      value?.kind === "request" &&
      [
        "file-document.operation",
        "explorer.operation",
        "surface.close",
      ].includes(value.command?.type)
    )
      frames.push({ socket: this, ...value, claimed: false });
  }
  return Reflect.apply(emit, this, [event, ...args]);
};
export async function fileDocumentHttpWorker({
  fixture,
  root,
  visit,
  result,
  operationType = "file-document.operation",
}) {
  await visit(
    "document worker enrollment code",
    "POST",
    "/api/workers/enrollment-codes",
    { json: {}, status: 201 },
  );
  const enrolled = await visit(
    "document worker enrollment",
    "POST",
    "/api/internal/workers/enroll",
    {
      client: "worker",
      json: {
        code: fixture.records.get("document worker enrollment code").code,
        heartbeat: { ...heartbeat, workerId: "alpha" },
      },
      status: 201,
    },
  );
  const config = {
    dataDirectory: path.join(root, "alpha"),
    name: "Controlled document worker",
    serverUrl: fixture.server.origin,
    enrollmentCode: null,
    replacement: null,
    token: enrolled.credential,
    tokenSource: "persisted",
    workerId: "alpha",
  };
  saveWorkerCredential({
    credential: config.token,
    dataDirectory: config.dataDirectory,
    serverUrl: config.serverUrl,
    workerId: "alpha",
  });
  let connected = false;
  const state = { mode: "ok", pending: [], socket: null, surfaceCommands: [] };
  const connection = new WorkerConnection(
    config,
    async (command) => {
      if (command.type === "surface.close") {
        const frame = frames.find(
          (f) => !f.claimed && isDeepStrictEqual(f.command, command),
        );
        assert.ok(frame, "surface close reaches unchanged worker decoder");
        frame.claimed = true;
        state.socket = frame.socket;
        state.surfaceCommands.push(command);
        return null;
      }
      if (command.type !== operationType) return null;
      const frame = frames.find(
        (f) => !f.claimed && isDeepStrictEqual(f.command, command),
      );
      assert.ok(
        frame,
        "actual operation frame reaches unchanged worker decoder",
      );
      frame.claimed = true;
      state.socket = frame.socket;
      result.commands.push(command);
      const response = {
        ...fileDocumentWireFixtures().surfaceStreamWireResponseSchema[0],
        operationId: command.operationId,
        sequence: command.sequence,
      };
      if (state.mode === "error")
        throw new Error("controlled document worker failure");
      if (state.mode === "invalid") return null;
      if (state.mode === "extra") return { ...response, unexpected: true };
      if (state.mode === "hold")
        return new Promise((resolve) =>
          state.pending.push(() => resolve(response)),
        );
      return response;
    },
    undefined,
    undefined,
    undefined,
    1000,
    () => {
      connected = true;
    },
  );
  state.release = () => {
    for (const resolve of state.pending.splice(0)) resolve();
  };
  state.close = async () => {
    state.release();
    const closed =
      state.socket && state.socket.readyState !== WebSocket.CLOSED
        ? new Promise((resolve) => state.socket.once("close", resolve))
        : Promise.resolve();
    connection.close();
    await closed;
  };
  connection.start();
  await eventually(
    () => connected,
    (n) => assert.equal(n, true),
  );
  return state;
}
