import assert from "node:assert/strict";
import queries from "../../cantrip_server_rs/contracts/mcp-worktree-queries.json" with { type: "json" };
import {
  label,
  state as protectedState,
  json,
  literal,
} from "./project-target-state.mjs";
import { runStandaloneCases } from "./agent-run-http-boundaries.mjs";
import {
  settingsChat as chat,
  settingsProject as project,
  settingsTree as tree,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import {
  agentTree,
  mcpOperations,
  mutations,
  managedRoot,
} from "./agent-worktree-http-fixtures.mjs";

export function verifyTransitionQueryError({ body, args, rows, began }) {
  const lane = rows.lanes.find(
    (l) => l.worktree_id === args.worktreeId && l.state !== "released",
  );
  assert.ok(lane);
  const runtime = rows.runtimes.find((r) => r.id === lane.runtime_session_id);
  assert.ok(runtime);
  const query = queries.update,
    prefix = "Failed query: " + query.sql + "\nparams: ";
  assert.ok(
    body.error.startsWith(prefix),
    "Actual Source transition query is preserved after a failed SQL write",
  );
  const timestamp = body.error.slice(prefix.length).split(",").at(-2);
  assert.ok(Number.isFinite(Date.parse(timestamp)));
  assert.ok(
    Date.parse(timestamp) >= began - 1000 &&
      Date.parse(timestamp) <= Date.now() + 1000,
  );
  const fields = {
    id: lane.id,
    acquiring_actor: "agent",
    exclusive: true,
    purpose: args.purpose,
    state: "delivering",
    runtime_session_id: runtime.id,
    codex_thread_id: runtime.codex_thread_id,
    transition_kind: "switch",
    updated_at: timestamp,
  };
  assert.equal(
    body.error,
    (prefix + query.parameters.map((column) => fields[column]).join(",")).slice(
      0,
      2000,
    ),
    "Every actual ORM error parameter retains its original JavaScript value",
  );
  return {
    ...body,
    error: body.error.replace(timestamp, "<verified generated clock>"),
  };
}

export async function worktreeReadBoundaries({
  h,
  state,
  binding,
  call,
  result,
}) {
  const caps = await fetch(
    h.fixture.server.origin +
      "/api/internal/agent-operations/capabilities?workerId=" +
      worker,
    {
      headers: { authorization: "Bearer " + h.credential },
      signal: AbortSignal.timeout(15000),
    },
  );
  assert.equal(caps.status, 200);
  result.capabilities = await caps.json();
  for (const op of mcpOperations)
    assert.ok(result.capabilities.operations.includes(op));
  assert.equal(
    result.capabilities.operations.includes("worktree.acquire"),
    false,
  );
  result.capabilityProof = {
    worktreeOperations: result.capabilities.operations.filter((op) =>
      op.startsWith("worktree."),
    ),
  };
  assert.equal(result.capabilityProof.worktreeOperations.length, 6);

  const historical = [
    ["released-primary", tree, "released"],
    ["suspended-primary", tree, "suspended"],
    ["released-agent", agentTree, "released"],
    ["suspended-agent", agentTree, "suspended"],
  ];
  await h.fixture.sql(
    historical.flatMap(([id, root, status], index) => [
      `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label) VALUES(${literal(id)},${literal(h.owner)},${literal(project)},${literal(root)},${literal(worker)},${json(label("chat"))})`,
      `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,created_at,updated_at,released_at) VALUES(${literal(id)},${literal(id)},${literal(root)},${literal(worker)},'agent',false,'Historical fixture',${literal(status)},'2020-01-01T00:00:00Z','2020-01-0${index + 1}T00:00:00Z',${status === "released" ? "'2020-01-05T00:00:00Z'" : "NULL"})`,
    ]),
  );
  assert.deepEqual(
    (await call("hide released and suspended Primary", "list")).data.leases.map(
      (l) => l.id,
    ),
    ["mcp-worktree-lane", "suspended-agent"],
  );
  assert.equal(
    (
      await call("include actual historical leases", "list", {
        includeLeaseHistory: true,
      })
    ).data.leases.length,
    5,
  );
  assert.equal(
    (
      await call("history requires boolean true", "list", {
        includeLeaseHistory: "true",
      })
    ).data.leases.length,
    2,
  );
  await h.fixture.sql([
    `DELETE FROM chat_execution_lanes WHERE chat_id IN (${historical.map(([id]) => literal(id)).join(",")})`,
    `DELETE FROM chats WHERE id IN (${historical.map(([id]) => literal(id)).join(",")})`,
  ]);

  for (const args of [
    { target: false },
    { target: 0 },
    { target: "" },
    { worktreeId: "  " },
    { worktreeId: null },
  ])
    await call("falsy status fallback " + JSON.stringify(args), "status", args);
  for (const args of [{ target: [] }, { target: {} }, { worktreeId: 1 }])
    await call(
      "invalid status selector " + JSON.stringify(args),
      "status",
      args,
      400,
    );
  for (const action of ["switch", "remove"]) {
    await call("required target " + action, action, {}, 400);
    await call(
      "missing root " + action,
      action,
      { worktreeId: "missing-root", purpose: "Missing" },
      409,
    );
  }
  await call(
    "switch requires purpose after resolution",
    "switch",
    { worktreeId: agentTree },
    400,
  );
  state.branch = "\ud800\u0000branch 🚀";
  assert.equal(
    (await call("raw worker branch UTF16", "status")).summary,
    "main is clean on " + state.branch + ".",
  );
  state.branch = "";
  assert.equal(
    (await call("empty branch summary", "status")).summary,
    "main is clean on detached HEAD.",
  );
  state.branch = undefined;
  state.files = Array.from({ length: 2001 }, (_, i) => ({
    path: `file-${i}`,
    originalPath: null,
    indexStatus: " ",
    worktreeStatus: "M",
    staged: false,
    unstaged: true,
  }));
  const limited = await call("status actual file truncation", "status", {
    fileLimit: 2000,
    branchLimit: 1,
  });
  assert.equal(limited.data.status.files.length, 2000);
  assert.equal(limited.data.filesTruncated, true);
  assert.equal(limited.data.branchesTruncated, true);
  state.files = [];

  await h.fixture.sql([
    `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,origin,lifecycle_state) SELECT 'overflow-root-'||lpad(i::text,4,'0'),'settings-source',${literal(worker)},'Overflow '||i,${literal(managedRoot)}||'/overflow-'||i,${literal(managedRoot)}||'/overflow-'||i,'agent','ready' FROM generate_series(1,2001) i`,
  ]);
  const overflow = await call("worktree pagination hard cap", "list", {
    cursor: 1999,
    limit: 1,
  });
  assert.equal(overflow.data.total, 2000);
  assert.equal(overflow.data.nextCursor, null);
  assert.equal(overflow.data.truncated, true);
  await h.fixture.sql([
    "DELETE FROM project_worktrees WHERE id LIKE 'overflow-root-%'",
  ]);
  // The same physical tree can have historical lanes in distinct chats.
  await h.fixture.sql([
    `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label) SELECT 'overflow-chat-'||i,${literal(h.owner)},${literal(project)},${literal(tree)},${literal(worker)},${json(label("chat"))} FROM generate_series(1,1001) i`,
    `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,created_at,updated_at,released_at) SELECT 'overflow-lane-'||i,'overflow-chat-'||i,${literal(tree)},${literal(worker)},'agent',false,'History cap','released','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z'::timestamptz+i*interval '1 second','2020-01-05T00:00:00Z' FROM generate_series(1,1001) i`,
  ]);
  const cap = await call("selected lease history hard cap", "list", {
    cursor: 0,
    limit: 200,
    includeLeaseHistory: true,
  });
  assert.equal(cap.data.leases.length, 1000);
  assert.equal(cap.data.truncated, true);
  await h.fixture.sql([
    "DELETE FROM chat_execution_lanes WHERE chat_id LIKE 'overflow-chat-%'",
    "DELETE FROM chats WHERE id LIKE 'overflow-chat-%'",
  ]);

  for (const [name, patch, status] of [
    ["grant required", { allowedOperations: ["context.get"] }, 403],
    ["foreign owner", { ownerId: "unrelated-owner" }, 403],
    ["stale project", { projectId: "unrelated-project" }, 409],
    [
      "expired binding",
      { issuedAt: "2020-01-01T00:00:00Z", expiresAt: "2020-01-02T00:00:00Z" },
      401,
    ],
  ])
    await call(name, "list", {}, status, { ...binding, ...patch });
  await call("safe worktree discovery follows current lane", "list", {}, 200, {
    ...binding,
    executionLaneId: "old-lane",
    worktreeId: "old-root",
    permissionProfileId: ":read-only",
  });
  await call(
    "stale mutation lane fenced",
    "create",
    { name: "Denied", intent: "detached", baseRevision: "HEAD" },
    409,
    { ...binding, executionLaneId: "old-lane" },
  );
  await h.fixture.sql([
    `UPDATE chats SET worktree_mode='pinned' WHERE id=${literal(chat)}`,
  ]);
  await call(
    "pinned chat transition fenced",
    "switch",
    { worktreeId: agentTree, purpose: "Pinned" },
    409,
  );
  await h.fixture.sql([
    `UPDATE chats SET worktree_mode='agent-managed' WHERE id=${literal(chat)}`,
  ]);
  await h.fixture.sql([
    `UPDATE projects SET origin_kind='managed-folder',folder_management='external',worktree_policy='direct',github_repository_blind_index=NULL,git_capability=false,github_capability=false WHERE id=${literal(project)}`,
  ]);
  for (const op of mcpOperations)
    await call(
      "folder capability precedes argument validation " + op,
      op,
      {},
      409,
    );
  await h.fixture.sql([
    `UPDATE projects SET origin_kind='github',folder_management=NULL,worktree_policy='agent-managed',github_repository_blind_index='settings-project',git_capability=true,github_capability=true WHERE id=${literal(project)}`,
  ]);
}

export async function worktreeRemovalBoundaries({ h, state, call }) {
  const args = { worktreeId: agentTree };
  const blockers = [
    [
      "active chat",
      [
        `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,status) VALUES('worktree-blocker',${literal(h.owner)},${literal(project)},${literal(agentTree)},${literal(worker)},${json(label("chat"))},'running')`,
      ],
      ["DELETE FROM chats WHERE id='worktree-blocker'"],
    ],
    [
      "Code tab",
      [
        `INSERT INTO code_tabs(id,project_id,active_worker_id,worktree_id,protected_label) VALUES('worktree-code-blocker',${literal(project)},${literal(worker)},${literal(agentTree)},${json(label("code"))})`,
      ],
      ["DELETE FROM code_tabs WHERE id='worktree-code-blocker'"],
    ],
    [
      "running terminal",
      [
        `INSERT INTO terminals(id,project_id,active_worker_id,worktree_id,protected_label,protected_state,status) VALUES('worktree-terminal-blocker',${literal(project)},${literal(worker)},${literal(agentTree)},${json(label("terminal"))},${json(protectedState("terminal-state"))},'running')`,
      ],
      ["DELETE FROM terminals WHERE id='worktree-terminal-blocker'"],
    ],
  ];
  for (const [name, seed, cleanup] of blockers) {
    await h.fixture.sql(seed);
    const count = state.commands.length;
    await call(name + " blocks agent removal", "remove", args, 400);
    assert.equal(
      state.commands.length,
      count,
      "Database blockers prevent worker removal dispatch",
    );
    await h.fixture.sql(cleanup);
  }
  state.files = [
    {
      path: "dirty",
      originalPath: null,
      indexStatus: " ",
      worktreeStatus: "M",
      staged: false,
      unstaged: true,
    },
  ];
  const count = state.commands.length;
  await call("dirty root blocks agent removal", "remove", args, 400);
  assert.deepEqual(
    state.commands.slice(count).map((c) => c.type),
    ["worktree.status"],
  );
  state.files = [];
  for (const intent of ["existingBranch", "detached"]) {
    const created = await call("create " + intent, "create", {
      name: intent,
      intent,
      branch: intent === "existingBranch" ? "existing" : "ignored",
      baseRevision: "HEAD",
    });
    assert.equal(created.data.origin, "agent");
    await call("remove " + intent, "remove", {
      worktreeId: created.worktreeId,
    });
  }
}

export async function worktreeFinalBoundaries({ h, call, binding, result }) {
  await h.fixture.sql([
    `UPDATE chats SET permission_profile_id=':workspace',status='idle' WHERE id=${literal(chat)}`,
  ]);
  await call("inactive chat fenced", "status", {}, 409);
  await h.fixture.sql([
    `UPDATE chats SET status='running' WHERE id=${literal(chat)}`,
  ]);
  await runStandaloneCases({ h, call, binding, operations: mcpOperations });
  h.worker.close();
  await h.live.close();
  const port = Number(new URL(h.fixture.server.origin).port);
  await h.fixture.close();
  await h.fixture.start({ port });
  await h.reconnectWorker();
  await call("restart fences old worktree execution", "list", {}, 409);
  await h.fixture.sql([
    `UPDATE chats SET status='running' WHERE id=${literal(chat)}`,
  ]);
  binding.issuedAt = new Date().toISOString();
  binding.expiresAt = new Date(Date.now() + 120000).toISOString();
  await call("restart retains worktree inventory", "list");
  await call(
    "restart fences previous mutation lane",
    "create",
    { name: "Denied after restart", intent: "detached", baseRevision: "HEAD" },
    409,
  );
  result.actualServerRestartVerified = true;
  const [audit] = await h.fixture.sql(
    [],
    [
      "SELECT jsonb_build_object('events',coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb))::text result FROM audit_events a WHERE a.action LIKE 'mcp.operation.%'",
    ],
  );
  assert.equal(
    audit.events.length,
    result.calls.length + (result.disconnections?.length ?? 0),
    "Exactly one durable MCP audit per HTTP call",
  );
  const calls = new Map(
    [...result.calls, ...(result.disconnections ?? [])].map((c) => [
      c.httpRequestId,
      c,
    ]),
  );
  result.auditEvents = audit.events.map((event) => {
    const call = calls.get(event.request_id);
    assert.ok(call);
    assert.equal(event.owner_id, h.owner);
    assert.equal(event.actor_user_id, null);
    assert.equal(event.actor_session_id, null);
    assert.equal(event.resource_type, "mcp-binding");
    assert.equal(event.resource_id, call.bindingId ?? binding.bindingId);
    const succeeded = call.status === 200 || call.disconnected;
    const action = succeeded
      ? mutations.has(call.operation)
        ? "mcp.operation.mutated"
        : "mcp.operation.executed"
      : "mcp.operation.rejected";
    const outcome = succeeded
      ? "succeeded"
      : ["forbidden", "stale-binding", "expired"].includes(call.body.code)
        ? "denied"
        : "failed";
    assert.equal(event.action, action);
    assert.equal(event.result, outcome);
    return { name: call.name, action, result: outcome };
  });
}
