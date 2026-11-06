import assert from "node:assert/strict";
import path from "node:path";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { WorkerInferenceAdmission } from "../../cantrip_worker/src/inference-admission.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { heartbeat } from "./security-fixtures.mjs";
import {
  literal,
  json,
  label,
  state as protection,
  stamp,
} from "./project-target-state.mjs";
import { argumentsFor, target } from "./agent-surface-http-fixtures.mjs";
import {
  settingsProject as project,
  settingsTree as tree,
  settingsWorker as worker,
  until,
} from "./native-settings-http-fixture.mjs";

export async function surfacePlacementCases(c) {
  const { h, call, binding, result, state } = c;
  const runtime = "eeeeeeee-eeee-4eee-8eee-000000000811",
    configuration = "eeeeeeee-eeee-4eee-8eee-000000000810";
  await h.fixture.sql([
    `INSERT INTO run_configuration_runtimes(id,owner_id,project_id,configuration_id,worktree_id,worker_id,definition_revision,requested_operation_id,created_at,updated_at) VALUES(${literal(runtime)},${literal(h.owner)},${literal(project)},${literal(configuration)},${literal(tree)},${literal(worker)},${literal("a".repeat(64))},'eeeeeeee-eeee-4eee-8eee-000000000812',${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO terminals(id,project_id,kind,worktree_id,active_worker_id,run_configuration_id,run_configuration_runtime_id,created_at,updated_at) VALUES('mcp-run-terminal',${literal(project)},'run-configuration',${literal(tree)},${literal(worker)},${literal(configuration)},${literal(runtime)},${literal(stamp)},${literal(stamp)})`,
    `UPDATE run_configuration_runtimes SET terminal_id='mcp-run-terminal' WHERE id=${literal(runtime)}`,
  ]);
  await call("Run terminal snapshot remains readable", "terminal.read", {
    ...argumentsFor("terminal.read"),
    target: target("terminal", "mcp-run-terminal"),
  });
  for (const wire of [{}, argumentsFor("terminal.send")]) {
    const body = await call(
      "Run terminal rejects input before wire validation " +
        Object.keys(wire).length,
      "terminal.send",
      { ...wire, target: target("terminal", "mcp-run-terminal") },
      409,
    );
    assert.deepEqual(body, {
      code: "conflict",
      error:
        "Run configuration terminals are read-only. Use the Run configuration lifecycle and output operations instead.",
    });
    assert.equal(result.calls.at(-1).commands.length, 0);
  }
  await call(
    "Run terminal cannot restart interactive service",
    "terminal.restart",
    { target: target("terminal", "mcp-run-terminal") },
    400,
  );
  assert.equal(result.calls.at(-1).commands.length, 0);
  await h.fixture.sql([
    "DELETE FROM terminals WHERE id='mcp-run-terminal'",
    `DELETE FROM run_configuration_runtimes WHERE id=${literal(runtime)}`,
  ]);

  await h.fixture.sql([
    `UPDATE projects SET origin_kind='managed-folder',folder_management='external',worktree_policy='direct',github_repository_blind_index=NULL,git_capability=false,github_capability=false WHERE id=${literal(project)}`,
    `UPDATE project_sources SET source_kind='folder' WHERE id='settings-source'`,
    `UPDATE project_worktrees SET root_kind='folder-root',is_default=true WHERE id=${literal(tree)}`,
  ]);
  try {
    for (const op of [
      "explorer.read",
      "explorer.write",
      "terminal.read",
      "terminal.send",
      "terminal.restart",
      "browser.services",
    ])
      await call("folder root supports " + op, op, argumentsFor(op), 200, {
        ...binding,
        rootKind: "folder-root",
      });
  } finally {
    await h.fixture.sql([
      `UPDATE projects SET origin_kind='github',folder_management=NULL,worktree_policy='agent-managed',github_repository_blind_index='settings-project',git_capability=true,github_capability=true WHERE id=${literal(project)}`,
      "UPDATE project_sources SET source_kind='git' WHERE id='settings-source'",
      `UPDATE project_worktrees SET root_kind='git-worktree',is_default=false WHERE id=${literal(tree)}`,
    ]);
  }

  const secondary = "mcp-surface-secondary",
    secondaryTree = "eeeeeeee-eeee-4eee-8eee-000000000813";
  const code = await h.visit(
    "surface secondary enrollment code",
    "POST",
    "/api/workers/enrollment-codes",
    { status: 201, json: { label: "Surface secondary transport" } },
  );
  const enrollment = await h.visit(
    "surface secondary enrollment",
    "POST",
    "/api/internal/workers/enroll",
    {
      client: "surface-secondary",
      status: 201,
      json: {
        code: code.code,
        heartbeat: { ...heartbeat, workerId: secondary },
      },
    },
  );
  const config = {
    dataDirectory: path.join(
      c.root,
      h.fixture.name,
      h.fixture.kind,
      "surface-secondary",
    ),
    name: "Surface secondary transport",
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
      workerGeneration: "surface-secondary",
    },
    (error) => {
      throw error;
    },
  );
  let connected = 0,
    dispatches = 0;
  const connection = new WorkerConnection(
    config,
    async (command) => {
      const reply = await state.onCommand(command);
      if (reply !== undefined) {
        dispatches++;
        return reply;
      }
      if (command.type === "inference.configure") {
        for (const v of command.configurations) inference.configure(v);
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
      throw new Error(
        "Controlled secondary surface endpoint does not implement housekeeping",
      );
    },
    undefined,
    undefined,
    undefined,
    1000,
    () => connected++,
  );
  try {
    connection.start();
    await until(
      () => connected,
      (n) => n === 1,
    );
    await h.fixture.sql([
      `UPDATE workers SET remote_surface_capabilities='{"browser":true,"desktop":true}' WHERE id=${literal(secondary)}`,
      `INSERT INTO project_sources(id,project_id,worker_id,source_kind,absolute_path,display_path) VALUES('surface-secondary-source',${literal(project)},${literal(secondary)},'git','/surface-secondary','/surface-secondary')`,
      `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES(${literal(secondaryTree)},'surface-secondary-source',${literal(secondary)},'secondary','/surface-secondary','/surface-secondary',true,'cantrip','ready')`,
      ...[
        ["explorers", "explorer", "explorer-state"],
        ["terminals", "terminal", "terminal-state"],
      ].map(
        ([table, record, kind]) =>
          `INSERT INTO ${table}(id,project_id,active_worker_id,worktree_id,protected_label,protected_state) VALUES(${literal("secondary-" + record)},${literal(project)},${literal(secondary)},${literal(secondaryTree)},${json(label(record))},${json(protection(kind))})`,
      ),
      "UPDATE terminals SET service_enabled=true WHERE id='secondary-terminal'",
      `UPDATE remote_surfaces SET worker_id=${literal(secondary)} WHERE id='mcp-browser'`,
    ]);
    for (const op of [
      "explorer.list",
      "explorer.read",
      "explorer.write",
      "terminal.read",
      "terminal.send",
      "terminal.restart",
      "browser.services",
      "browser.open",
    ]) {
      const before = dispatches,
        kind = op.split(".")[0];
      const body = await call("owned other-worker target " + op, op, {
        ...argumentsFor(op),
        target: target(
          kind,
          kind === "browser" ? "mcp-browser" : "secondary-" + kind,
        ),
      });
      assert.equal(
        dispatches,
        before + 1,
        "The captured target worker receives this operation",
      );
      if (kind !== "browser") assert.equal(body.worktreeId, secondaryTree);
      assert.equal(
        binding.workerId,
        worker,
        "The caller retains its original worker binding",
      );
    }
  } finally {
    connection.close();
    await h.fixture.sql([
      `UPDATE remote_surfaces SET worker_id=${literal(worker)} WHERE id='mcp-browser'`,
    ]);
  }
}
