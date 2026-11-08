// Production worker transport; restart effects are controlled at the endpoint.
import assert from "node:assert/strict";
import path from "node:path";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { sendHeartbeat } from "../../cantrip_worker/src/heartbeat.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { heartbeat } from "./security-fixtures.mjs";
import { eventually } from "./full-worker.mjs";
export async function managementWorker({
  f,
  visit,
  root,
  state,
  handlers = {},
  onSurfaceFrame = () => undefined,
  onSentSurfaceFrame = () => undefined,
}) {
  const report = {
    ...heartbeat,
    workerId: "alpha",
    name: "alpha worker",
    platform: "darwin",
  };
  const code = await visit(
    "alpha enrollment code",
    "POST",
    "/api/workers/enrollment-codes",
    { status: 201, json: { label: "Management worker" } },
  );
  const enrollment = await visit(
    "alpha enroll",
    "POST",
    "/api/internal/workers/enroll",
    {
      status: 201,
      client: "worker",
      json: { code: code.code, heartbeat: report },
    },
  );
  const config = {
    dataDirectory: path.join(root, "alpha"),
    name: report.name,
    serverUrl: f.server.origin,
    enrollmentCode: null,
    replacement: null,
    token: enrollment.credential,
    tokenSource: "persisted",
    workerId: "alpha",
  };
  saveWorkerCredential({
    credential: config.token,
    dataDirectory: config.dataDirectory,
    serverUrl: config.serverUrl,
    workerId: config.workerId,
  });
  let connection,
    connected = false;
  const start = async () => {
    connected = false;
    connection = new WorkerConnection(
      config,
      async (command, emit) => {
        if (command.type === "worktree.observation.configure")
          return { accepted: true, paths: [] };
        if (Object.hasOwn(handlers, command.type))
          return handlers[command.type](command, emit);
        if (command.type !== "worker.restart") {
          state.background.push(command);
          throw new Error(
            "Unsupported controlled management background command " +
              command.type,
          );
        }
        state.commands.push(command);
        if (state.intercept) await state.intercept(command);
        if (state.failRestart)
          throw new Error("Controlled worker restart failure");
        return (
          state.restartResult ?? {
            restarting: true,
            unknown: "Source strips unknown acknowledgment fields",
          }
        );
      },
      onSurfaceFrame,
      undefined,
      () => {
        connected = false;
        state.disconnects += 1;
      },
      1000,
      () => {
        connected = true;
      },
    );
    connection.start();
    await eventually(
      () => connected,
      (value) => assert.equal(value, true),
    );
    await sendHeartbeat(config, report);
  };
  await start();
  return {
    report,
    config,
    start,
    get connected() {
      return connected;
    },
    pulse: () => sendHeartbeat(config, report),
    notify: (notification) => connection.sendNotification(notification),
    surfaceFrame: (header, payload) => {
      const accepted = connection.sendSurfaceFrame(header, payload);
      if (accepted) onSentSurfaceFrame(header, payload);
      return accepted;
    },
    close() {
      connection.close();
    },
  };
}
