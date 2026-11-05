import assert from "node:assert/strict";
import path from "node:path";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { WorkerInferenceAdmission } from "../../cantrip_worker/src/inference-admission.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { heartbeat } from "./security-fixtures.mjs";
import { literal } from "./project-target-state.mjs";
import {
  settingsWorker as worker,
  settingsProject as project,
  settingsTree as tree,
  until,
} from "./native-settings-http-fixture.mjs";

const secondary = "mcp-run-secondary-worker";
const secondaryTree = "eeeeeeee-eeee-4eee-8eee-000000000709";

export async function runWorkerBindingCases({
  h,
  state,
  call,
  id,
  configurationId,
  root,
  profile,
  kind,
}) {
  const code = await h.visit(
    "Run secondary worker enrollment code",
    "POST",
    "/api/workers/enrollment-codes",
    { status: 201, json: { label: "Run secondary transport" } },
  );
  const enrollment = await h.visit(
    "Run secondary worker enrollment",
    "POST",
    "/api/internal/workers/enroll",
    {
      client: "secondary-worker",
      status: 201,
      json: {
        code: code.code,
        heartbeat: { ...heartbeat, workerId: secondary },
      },
    },
  );
  const config = {
    dataDirectory: path.join(
      root,
      profile,
      kind,
      "secondary-controlled-worker",
    ),
    name: "Run secondary transport",
    serverUrl: h.fixture.server.origin,
    enrollmentCode: null,
    replacement: null,
    token: enrollment.credential,
    tokenSource: "persisted",
    workerId: secondary,
  };
  saveWorkerCredential({
    credential: config.token,
    dataDirectory: config.dataDirectory,
    serverUrl: config.serverUrl,
    workerId: secondary,
  });
  const inference = new WorkerInferenceAdmission(
    {
      serverId: h.serverId,
      ownerId: h.owner,
      workerId: secondary,
      workerGeneration: "fixture-secondary",
    },
    (error) => {
      throw error;
    },
  );
  let connection,
    connected = 0,
    secondaryRunCommands = 0,
    release,
    inFlight;
  connection = new WorkerConnection(
    config,
    async (command, emit) => {
      if (command.type.startsWith("project.run-configuration-")) {
        if (command.type !== "project.run-configuration-runtime.reconcile")
          secondaryRunCommands++;
        return state.onCommand(command, emit, {
          encryption: h.encryption,
          owner: h.owner,
          serverId: h.serverId,
          scope: { ...h.scope, workerId: secondary },
        });
      }
      if (command.type === "inference.configure") {
        for (const c of command.configurations) inference.configure(c);
        return inference.snapshot();
      }
      if (command.type === "inference.status")
        return {
          ...inference.snapshot(),
          workerGeneration: connection.connectionGeneration(),
        };
      if (command.type === "chat.scratch.reconcile")
        return {
          retainedRootIds: command.roots.map((r) => r.rootId),
          missingRootIds: [],
          orphanedRootIds: [],
          dueRootIds: [],
        };
      throw new Error("Controlled secondary Run worker command is unsupported");
    },
    undefined,
    undefined,
    undefined,
    1000,
    () => connected++,
  );
  const prefer = (workerId) =>
    h.fixture.sql([
      `UPDATE projects SET preferred_worker_id=${literal(workerId)} WHERE id=${literal(project)}`,
    ]);
  try {
    connection.start();
    await until(
      () => connected,
      (n) => n === 1,
    );
    await h.fixture.sql([
      `INSERT INTO project_sources(id,project_id,worker_id,source_kind,absolute_path,display_path) VALUES('mcp-run-secondary-source',${literal(project)},${literal(secondary)},'git','/secondary/run','/secondary/run')`,
      `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES(${literal(secondaryTree)},'mcp-run-secondary-source',${literal(secondary)},'secondary','/secondary/run','/secondary/run',true,'cantrip','ready')`,
    ]);
    await prefer(secondary);
    for (const [action, args] of [
      ["list", {}],
      ["get", { configurationId }],
      ["detect", {}],
    ]) {
      const count = secondaryRunCommands;
      await call(
        "read binds actual secondary dispatch " + action,
        action,
        args,
        409,
      );
      assert.equal(
        secondaryRunCommands,
        count + 1,
        "Read checks its actual dispatched worker after the response",
      );
    }
    for (const action of ["create", "update", "delete", "secret-set"]) {
      const count = state.commands.length;
      await call(
        "mutation binding precedes argument parsing " + action,
        action,
        {},
        409,
      );
      assert.equal(state.commands.length, count);
    }
    const before = state.commands.length;
    await call(
      "read parses before secondary dispatch",
      "list",
      { unknown: true },
      400,
    );
    assert.equal(state.commands.length, before);
    for (const action of [
      "start",
      "restart",
      "stop",
      "read-output",
      "status",
    ]) {
      const count = state.commands.length;
      const args = {
        configurationId,
        worktreeId: secondaryTree,
        ...(action === "status" ? {} : { operationId: id() }),
      };
      await call(
        "runtime target requires bound worker " + action,
        action,
        args,
        409,
      );
      assert.equal(
        state.commands.length,
        count,
        "Foreign worker runtime cannot dispatch",
      );
    }
    await call("untargeted status does not bind Primary worker", "status");
    await prefer(worker);
    let requested = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    state.beforeRunCommand = async (command) => {
      if (command.type === "project.run-configuration-definitions.list") {
        requested = true;
        await gate;
      }
    };
    inFlight = call("Primary movement retains exact dispatched source", "list");
    await until(() => requested, Boolean);
    await prefer(secondary);
    release();
    assert.equal((await inFlight).worktreeId, tree);
    state.workerBindingProofs = {
      actualSecondaryTransport: true,
      secondaryReadDispatches: secondaryRunCommands,
      mutationPrevalidationDenials: 4,
      runtimeDispatchDenials: 5,
      primaryMovementRetainsDispatchedSource: true,
    };
  } finally {
    release?.();
    state.beforeRunCommand = undefined;
    if (inFlight) await Promise.allSettled([inFlight]);
    await prefer(worker);
    connection.close();
  }
}
