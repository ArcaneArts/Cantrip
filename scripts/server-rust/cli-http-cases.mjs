// Production HTTP/SDK scenarios. Only the endpoint replies and setup state are controlled.
import assert from "node:assert/strict";
import { hashSecret } from "../../tests/reference-node-server/src/auth/service.ts";
import {
  invokeCantripCliCommand,
  CantripServerRequestError,
} from "../../cantrip_worker/src/cli-client.ts";
import {
  literal,
  state as protectedState,
  label,
} from "./project-target-state.mjs";
import {
  settingsChat as chat,
  settingsProject as project,
  settingsTree as tree,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import { lane, argumentsFor } from "./agent-surface-http-fixtures.mjs";
import { agentTree } from "./agent-worktree-http-fixtures.mjs";
import { configurationId } from "./agent-run-http-fixtures.mjs";
import { policyIds } from "./agent-policy-http-fixtures.mjs";
import { cliRecovery } from "./cli-http-recovery.mjs";
import { cliWorkerHeartbeat } from "./cli-worker-heartbeat.mjs";
export async function cliHttpCases({
  verifiedSecretValues,
  h,
  policies,
  base,
  surfaces,
  runs,
  call,
  id,
  result,
  normalize,
}) {
  result.sdkScenarios = [];
  for (const [command, args] of [
    ["worktree.status", {}],
    ["run.list", {}],
    [
      "terminal.send",
      { ...argumentsFor("terminal.send"), target: "mcp-terminal" },
    ],
  ]) {
    await cliWorkerHeartbeat(h, result);
    const response = await invokeCantripCliCommand({
      chatContext: base.chatContext,
      request: {
        command,
        context: { ...base.context, selection: "auto" },
        arguments: args,
      },
      requestId: id(),
      workerId: worker,
      token: h.credential,
      serverUrl: h.fixture.server.origin,
    });
    assert.equal(response.mutated, command === "terminal.send");
    result.sdkScenarios.push(normalize({ command, response }));
  }
  const missingPolicyRequest = {
    command: "policy.read",
    context: { ...base.context, selection: "auto" },
    arguments: { policyId: "missing" },
  };
  await assert.rejects(
    () =>
      invokeCantripCliCommand({
        chatContext: base.chatContext,
        request: missingPolicyRequest,
        requestId: id(),
        workerId: worker,
        token: h.credential,
        serverUrl: h.fixture.server.origin,
      }),
    (error) => {
      assert.ok(error instanceof CantripServerRequestError);
      assert.equal(error.status, 404);
      assert.equal(error.code, "not-found");
      result.sdkScenarios.push({
        command: "policy.read",
        error: {
          status: error.status,
          code: error.code,
          message: error.message,
        },
      });
      return true;
    },
  );
  await call("status lane", "status");
  await call("status terminal", "status", {}, 200, {
    chatContext: null,
    context: { ...base.context, terminalId: "mcp-terminal" },
  });
  await call("status cwd", "status", {}, 200, {
    chatContext: null,
    context: { ...base.context, cwd: "/worker-owned/settings" },
  });
  await call("policy list", "policy.list");
  const readPolicy = await call("policy read opaque body", "policy.read", {
    policyId: policyIds.workspace,
  });
  await policies.verifyRead(readPolicy.data, policyIds.workspace);
  await call(
    "policy read missing",
    "policy.read",
    { policyId: "missing" },
    404,
  );
  await h.fixture.sql([
    `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,status) VALUES('cli-malformed-unrelated-chat',${literal(h.owner)},${literal(project)},${literal(tree)},${literal(worker)},'{}'::jsonb,'idle')`,
  ]);
  try {
    await call(
      "exact Terminal ignores unrelated malformed Chat",
      "target.resolve-terminal",
      { target: "mcp-terminal" },
    );
    await call(
      "focused Explorer ignores unrelated malformed Chat",
      "target.resolve-explorer",
    );
    await call(
      "untyped exact lookup ignores unrelated malformed Chat",
      "target.show",
      { target: "mcp-terminal" },
    );
    await call(
      "untyped partial lookup ignores unrelated malformed Chat",
      "target.show",
      { target: "mcp-term" },
    );
    const invalidCatalog = await call(
      "full catalog retains stored Chat validation diagnostics",
      "target.list",
      {},
      400,
    );
    assert.ok(invalidCatalog.error.includes("titleProtection"));
    const invalidFilter = await call(
      "catalog reads precede target kind validation",
      "target.list",
      { kind: "invalid" },
      400,
    );
    assert.equal(invalidFilter.error, invalidCatalog.error);
  } finally {
    await h.fixture.sql([
      "DELETE FROM chats WHERE id='cli-malformed-unrelated-chat'",
    ]);
  }
  await call("target list", "target.list");
  for (const kind of ["browser", "explorer", "terminal", "worker", "worktree"])
    await call("target list " + kind, "target.list", { kind });
  for (const command of [
    "target.show",
    "target.resolve-browser",
    "target.resolve-explorer",
    "target.resolve-terminal",
  ])
    await call(command, command);
  for (const target of [
    "mcp-terminal",
    "mcp-explorer",
    "mcp-browser",
    worker,
    tree,
    "CLI Selector Worker",
    "not-a-target",
    "\ud800",
  ])
    await call(
      "untyped " + target,
      "target.show",
      { target },
      target === "not-a-target" || target === "\ud800" ? 404 : 200,
    );
  for (const command of [
    "explorer.list",
    "explorer.read",
    "explorer.write",
    "terminal.read",
    "terminal.send",
    "terminal.restart",
    "browser.services",
    "browser.open",
  ]) {
    const args = argumentsFor(command);
    args.target = "mcp-" + command.split(".")[0];
    await call(command, command, args);
  }
  await call(
    "browser stale",
    "browser.open",
    {
      target: "mcp-browser",
      expectedStateRevision: 1,
      stateProtection: protectedState("browser-state"),
    },
    409,
  );
  const browser = {
    id: "eeeeeeee-eeee-4eee-8eee-000000000904",
    titleProtection: label("browser"),
    stateProtection: protectedState("browser-state"),
  };
  await call("browser create", "browser.create", browser);
  await call("run empty list", "run.list");
  await call("run missing", "run.show", { configurationId }, 404);
  await call("run detect", "run.detect", { provider: "shell" });
  await call("run create", "run.create", { document: runs.document });
  await call("run show", "run.show", { configurationId });
  await call("run list", "run.list");
  await call("run update", "run.update", {
    document: runs.document,
    configurationId,
    revision: "a".repeat(64),
  });
  for (const command of [
    "run.start",
    "run.status",
    "run.logs",
    "run.restart",
    "run.stop",
  ])
    await call(command, command, { configurationId });
  await call("run secret invalid", "run.secret-set", {}, 400);
  const protectedValue = await runs.seal(project);
  verifiedSecretValues.add(JSON.stringify(protectedValue));
  await call("run encrypted secret", "run.secret-set", {
    reference: "run/api",
    protectedValue,
  });
  await call("run with endpoint secret verification", "run.start", {
    configurationId,
  });
  assert.ok(runs.secretProofs > 0);
  await call("stop encrypted run", "run.stop", { configurationId });
  await call(
    "run delete stale revision",
    "run.delete",
    { configurationId, revision: "a".repeat(64) },
    409,
  );
  await call("run delete", "run.delete", {
    configurationId,
    revision: runs.definitions.entry.revision,
  });
  await call("worktree list", "worktree.list");
  await call("worktree status", "worktree.status");
  await call("worktree create invalid", "worktree.create", {}, 400);
  await call("worktree switch invalid", "worktree.switch", {}, 400);
  await call("worktree remove invalid", "worktree.remove", {}, 400);
  await call("worktree release without lane", "worktree.release", {}, 409, {
    chatContext: null,
    context: { ...base.context, cwd: "/worker-owned/settings" },
  });
  for (const [command, args] of [
    ["policy.read", {}],
    ["run.detect", { provider: "unknown" }],
    ["run.create", { document: { name: "\ud800" } }],
    ["explorer.read", { target: "mcp-explorer" }],
    ["target.list", { kind: "bad" }],
    ["browser.create", {}],
  ])
    await call("invalid " + command, command, args, 400);
  for (const command of [
    "policy.list",
    "run.list",
    "target.show",
    "worktree.list",
  ])
    await call("irrelevant bad target " + command, command, { target: 3 }, 400);
  await call("explicit lane ignores unrelated cwd", "policy.list", {}, 200, {
    context: { ...base.context, cwd: "/outside", selection: "lane" },
  });
  await call("explicit cwd ignores stale chat lane", "policy.list", {}, 200, {
    chatContext: { chatId: chat, executionLaneId: "stale-lane" },
    context: {
      ...base.context,
      cwd: "/worker-owned/settings",
      selection: "cwd",
    },
  });
  await call("stale chat lane rejected", "status", {}, 409, {
    chatContext: { chatId: chat, executionLaneId: "stale-lane" },
  });
  await call("explicit lane has no inferred context", "policy.list", {}, 400, {
    chatContext: null,
    context: { ...base.context, selection: "lane" },
  });
  await call("strict outer request", "status", {}, 400, {
    unknown: true,
  });
  await call(
    "CLI twenty argument boundary",
    "policy.list",
    Object.fromEntries(Array.from({ length: 20 }, (_, i) => ["key" + i, i])),
  );
  await call(
    "CLI twenty-one arguments rejected",
    "policy.list",
    Object.fromEntries(Array.from({ length: 21 }, (_, i) => ["key" + i, i])),
    400,
  );
  await h.fixture.sql([
    `UPDATE chats SET permission_profile_id=':read-only' WHERE id=${literal(chat)}`,
  ]);
  for (const command of [
    "run.create",
    "run.update",
    "run.delete",
    "run.start",
    "run.restart",
    "run.stop",
    "run.secret-set",
  ])
    await call(
      "read-only precedes argument parsing " + command,
      command,
      {},
      409,
    );
  await call(
    "target parsing precedes read-only run guard",
    "run.create",
    { target: 3 },
    400,
  );
  await h.fixture.sql([
    `UPDATE chats SET permission_profile_id=':workspace' WHERE id=${literal(chat)}`,
  ]);
  surfaces.mode = "failure";
  surfaces.failure = "CLI full worker error " + "x".repeat(2500) + "\ud800";
  await call(
    "full worker failure",
    "terminal.read",
    { ...argumentsFor("terminal.read"), target: "mcp-terminal" },
    400,
  );
  surfaces.mode = "normal";
  await call(
    "mutation completed before audit argument failure",
    "terminal.send",
    {
      ...argumentsFor("terminal.send"),
      target: "mcp-terminal",
      configurationId: 3,
    },
    400,
  );
  assert.equal(result.calls.at(-1).commands.length, 1);
  await call(
    "mutation requires valid worker credentials",
    "run.delete",
    { configurationId, revision: "a".repeat(64) },
    401,
    {},
    "invalid",
  );
  await call(
    "worker credential cannot impersonate another worker",
    "worktree.create",
    {},
    401,
    { workerId: "foreign-worker" },
  );
  await call("wrong worker authentication", "status", {}, 401, {}, "invalid");
  await call("unknown command", "shell.run", {}, 400);
  // Missing-table tests execute the real repository query before either
  // server attaches its normal ORM diagnostic. Restore the fixture after.
  await h.fixture.sql([
    "ALTER TABLE terminals RENAME TO cli_terminals_missing",
  ]);
  try {
    await call(
      "exact target real SQL failure",
      "target.resolve-terminal",
      { target: "mcp-terminal" },
      400,
    );
    assert.ok(result.calls.at(-1).body.error.startsWith("Failed query: "));
    await call(
      "untyped target real SQL failure",
      "target.show",
      { target: "mcp-terminal" },
      400,
    );
    assert.ok(result.calls.at(-1).body.error.length > 6000);
  } finally {
    await h.fixture.sql([
      "ALTER TABLE cli_terminals_missing RENAME TO terminals",
    ]);
  }
  await cliRecovery({
    h,
    state: surfaces,
    base,
    call,
    id,
    result,
    normalize,
  });
  const created = await call("CLI derived branch", "worktree.create", {
    name: "CLI feature",
    intent: "newBranch",
  });
  assert.equal(created.data.branch, "cantrip/cli-feature");
  const collision = await call(
    "CLI derived branch collision",
    "worktree.create",
    { name: "CLI feature", intent: "newBranch" },
  );
  assert.equal(collision.data.branch, "cantrip/cli-feature-2");
  await call("remove first created CLI worktree", "worktree.remove", {
    worktree: created.worktreeId,
  });
  await call("remove second created CLI worktree", "worktree.remove", {
    worktree: collision.worktreeId,
  });
  const switched = await call("switch CLI by exact branch", "worktree.switch", {
    worktree: "feature-a",
  });
  assert.equal(switched.continuationScheduled, true);
  assert.equal(switched.data.lane.state, "delivering");
  // Prepare a secondary active lane to exercise release independently of
  // native-turn product acceptance; the scheduled lane above is durable.
  await h.fixture.sql([
    `UPDATE chat_execution_lanes SET state='suspended',transition_kind=NULL WHERE id=${literal(base.chatContext.executionLaneId)}`,
    `UPDATE chat_execution_lanes SET state='active',transition_kind=NULL,activated_at=now() WHERE id=${literal(switched.data.lane.id)}`,
    `UPDATE chats SET active_worktree_id=${literal(agentTree)} WHERE id=${literal(chat)}`,
  ]);
  base.chatContext.executionLaneId = switched.data.lane.id;
  const released = await call("release CLI secondary lane", "worktree.release");
  assert.equal(released.worktreeId, tree);
  assert.equal(released.continuationScheduled, true);
  await h.fixture.sql([
    `UPDATE project_branch_leases SET state='released',released_at=now(),updated_at=now() WHERE project_id=${literal(project)}`,
    `UPDATE chat_execution_lanes SET state='released',transition_kind=NULL,released_at=now() WHERE chat_id=${literal(chat)} AND id<>${literal(lane)}`,
    `UPDATE chat_execution_lanes SET state='active',transition_kind=NULL,released_at=NULL WHERE id=${literal(lane)}`,
    `UPDATE chats SET active_worktree_id=${literal(tree)} WHERE id=${literal(chat)}`,
  ]);
  base.chatContext.executionLaneId = lane;
  const acquired = await call("CLI create and acquire", "worktree.create", {
    name: "CLI acquired",
    intent: "newBranch",
    switch: true,
  });
  assert.equal(acquired.continuationScheduled, true);
  assert.equal(
    acquired.data.lane.purpose,
    "Continue in CLI acquired from the Cantrip CLI",
  );
  const unicodeCredential = "ctwk_" + "u".repeat(43);
  await h.fixture.sql([
    `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES('�',${literal(h.owner)},'Unicode CLI worker','linux','x64',now(),now())`,
    `INSERT INTO worker_credentials(id,owner_id,worker_id,secret_hash,scopes) SELECT 'eeeeeeee-eeee-4eee-8eee-000000000997',owner_id,'�',${literal(hashSecret(unicodeCredential))},scopes FROM worker_credentials WHERE worker_id=${literal(worker)} AND revoked_at IS NULL LIMIT 1`,
  ]);
  for (const workerId of ["\ufffd", "\ud800"]) {
    const status = await call(
      "CLI status worker identity " + JSON.stringify(workerId),
      "status",
      {},
      200,
      {
        workerId,
        chatContext: null,
        context: { cwd: null, terminalId: null, codexThreadId: null },
      },
      unicodeCredential,
    );
    assert.equal(
      status.data.worker.id,
      "\ufffd",
      "Status identifies the stored worker after the SQL UTF-8 boundary",
    );
    assert.equal(status.data.worker.online, false);
  }
}
