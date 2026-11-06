import assert from "node:assert/strict";
import {
  CANTRIP_MCP_OPERATIONS,
  isCantripMcpMutationOperation,
} from "../../packages/protocol/dist/index.js";
import { workerLocalOperations } from "./mcp-worker-local-fixtures.mjs";
import { literal, json, label } from "./project-target-state.mjs";
import {
  settingsChat as chat,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";

export async function workerLocalHttpCases(c) {
  const { h, binding, call } = c;
  binding.allowedOperations = [...CANTRIP_MCP_OPERATIONS];
  for (const operation of workerLocalOperations) {
    const response = await call(`direct ${operation}`, operation, {}, 400);
    assert.deepEqual(response, {
      code: "invalid",
      error: `Unsupported Cantrip agent operation: ${operation}`,
    });
    await call(`no grant ${operation}`, operation, {}, 403, {
      ...binding,
      allowedOperations: binding.allowedOperations.filter(
        (op) => op !== operation,
      ),
    });
    await call(`foreign owner ${operation}`, operation, {}, 403, {
      ...binding,
      ownerId: "foreign-owner",
    });
    await call(`expired ${operation}`, operation, {}, 401, {
      ...binding,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await call(
      `old lane ${operation}`,
      operation,
      {},
      isCantripMcpMutationOperation(operation) ? 409 : 400,
      { ...binding, executionLaneId: "old-worker-web-lane" },
    );
  }
  await call(
    "CLI-only worktree.acquire stays forbidden",
    "worktree.acquire",
    {},
    403,
  );
  await h.fixture.sql([
    `UPDATE chats SET permission_profile_id=':read-only' WHERE id=${literal(chat)}`,
  ]);
  for (const operation of workerLocalOperations)
    await call(
      `read-only ${operation}`,
      operation,
      {},
      ["tool.help", "web.search", "web.read"].includes(operation) ? 400 : 403,
      { ...binding, permissionProfileId: ":read-only" },
    );
  await h.fixture.sql([
    `UPDATE chats SET permission_profile_id=':workspace',status='idle' WHERE id=${literal(chat)}`,
  ]);
  for (const operation of workerLocalOperations)
    await call(`idle ${operation}`, operation, {}, 409);
  await h.fixture.sql([
    `UPDATE chats SET status='running' WHERE id=${literal(chat)}`,
  ]);
  const standalone = "eeeeeeee-eeee-4eee-8eee-000000000900";
  await h.fixture.sql([
    `INSERT INTO chats(id,owner_id,context_kind,protected_label,active_worker_id,active_scratch_root_id,worktree_mode,status,permission_profile_id) VALUES(${literal(standalone)},${literal(h.owner)},'standalone',${json(label("chat"))},${literal(worker)},'mcp-web-scratch',NULL,'running',':workspace')`,
    `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,protected_path_handle,status) VALUES('mcp-web-scratch',${literal(standalone)},${literal(h.owner)},${literal(worker)},'ctrr_${"A".repeat(43)}','ready')`,
    `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,scratch_root_id,codex_thread_id) VALUES('mcp-web-standalone-runtime',${literal(standalone)},${literal(worker)},'mcp-web-scratch','mcp-web-thread')`,
    `INSERT INTO chat_execution_lanes(id,chat_id,scratch_root_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES('mcp-web-standalone-lane',${literal(standalone)},'mcp-web-scratch',${literal(worker)},'agent',false,'Qualification','active',now(),'mcp-web-standalone-runtime')`,
  ]);
  for (const operation of workerLocalOperations) {
    const response = await call(
      `standalone direct ${operation}`,
      operation,
      {},
      409,
      {
        ...binding,
        contextKind: "standalone",
        chatId: standalone,
        executionLaneId: "mcp-web-standalone-lane",
        projectId: null,
        worktreeId: null,
        rootKind: null,
        scratchRootId: "mcp-web-scratch",
      },
    );
    assert.deepEqual(response, {
      code: "unsupported-capability",
      error: "Standalone Chats do not support IDE execution operations.",
    });
  }
}
