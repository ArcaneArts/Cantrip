import assert from "node:assert/strict";
import { nativeCommandAdmissionSchema } from "../../packages/protocol/dist/index.js";
import {
  settingsChat as agent,
  settingsProject as project,
  settingsTree as tree,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import { literal, json, label } from "./project-target-state.mjs";
import { createWorkerCredential } from "../../cantrip_server/src/workers/credentials.ts";
export const rejectedEventCredentials = ["scope", "revoked", "expired"].map(
  (reason) => ({ reason, ...createWorkerCredential() }),
);
export const task = "55555555-5555-4555-8555-555555555555",
  taskProject = "66666666-6666-4666-8666-666666666666",
  taskTree = "77777777-7777-4777-8777-777777777777",
  standalone = "88888888-8888-4888-8888-888888888888",
  scratch = "99999999-9999-4999-8999-999999999999";
export function seedEventChats(owner) {
  return [
    `INSERT INTO user_settings(user_id,computer_use_enabled) VALUES(${literal(owner)},true) ON CONFLICT(user_id) DO UPDATE SET computer_use_enabled=true`,
    ...rejectedEventCredentials.map(
      (c) =>
        `INSERT INTO worker_credentials(id,owner_id,worker_id,secret_hash,scopes,revoked_at,expires_at) VALUES(${literal(c.credentialId)},${literal(owner)},${literal(worker)},${literal(c.credentialHash)},${json(c.reason === "scope" ? [] : ["worker:agent-tools"])},${c.reason === "revoked" ? "now()" : "NULL"},${c.reason === "expired" ? "'2000-01-01'" : "NULL"})`,
    ),
    `INSERT INTO projects(id,owner_id,protected_label,origin_kind,git_capability,github_capability,worktree_policy,preferred_worker_id,github_repository_blind_index) VALUES(${literal(taskProject)},${literal(owner)},${json(label("project"))},'github',true,true,'agent-managed',${literal(worker)},'event-task-project')`,
    `INSERT INTO project_sources(id,project_id,worker_id,source_kind,absolute_path,display_path) VALUES('event-task-source',${literal(taskProject)},${literal(worker)},'git','/event-task','/event-task')`,
    `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES(${literal(taskTree)},'event-task-source',${literal(worker)},'main','/event-task','/event-task',true,'cantrip','ready')`,
    `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,experience) VALUES(${literal(task)},${literal(owner)},${literal(taskProject)},${literal(taskTree)},${literal(worker)},${json(label("chat"))},'task')`,
    `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id) VALUES('event-task-runtime',${literal(task)},${literal(worker)},${literal(taskTree)},'task-thread')`,
    `INSERT INTO chats(id,owner_id,context_kind,active_worker_id,active_scratch_root_id,worktree_mode,protected_label) VALUES(${literal(standalone)},${literal(owner)},'standalone',${literal(worker)},${literal(scratch)},NULL,${json(label("chat"))})`,
    `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,status,protected_path_handle) VALUES(${literal(scratch)},${literal(standalone)},${literal(owner)},${literal(worker)},'ready','ctrr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`,
    `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,scratch_root_id,codex_thread_id) VALUES('event-standalone-runtime',${literal(standalone)},${literal(worker)},${literal(scratch)},'standalone-thread')`,
  ];
}
export async function prepareEventCommands(h) {
  const result = {};
  for (const [chat, projectId, placementId, threadId] of [
    [agent, project, tree, "thread"],
    [task, taskProject, taskTree, "task-thread"],
    [standalone, null, scratch, "standalone-thread"],
  ]) {
    const operationId = "event-" + chat;
    const session = {
      chatId: chat,
      threadId,
      contextKind: projectId ? "project" : "standalone",
      projectId,
      placementId,
      modelRouteId: null,
      providerAccountId: null,
      runtimeGeneration: "runtime",
      connectionId: "connection",
    };
    const admission = nativeCommandAdmissionSchema.parse({
      workerId: worker,
      operationId,
      origin: "gui",
      session,
      method: "turn/start",
      payloadDigest: "a".repeat(64),
      protectedPayload: label("chat").protectedLabel.envelope,
      expectedActivationGeneration: null,
      intent: { scope: "thread" },
    });
    const auth = {
      client: "worker",
      headers: { authorization: "Bearer " + h.credential },
    };
    if (chat === agent) {
      for (const phase of ["admit", "dispatch", "bind-preparation"])
        await h.visit(
          "HTTP invalid native " + phase,
          "POST",
          "/api/internal/native-commands/" + phase,
          { client: "worker", json: {}, status: 400 },
        );
      await h.visit(
        "HTTP admission requires worker credential",
        "POST",
        "/api/internal/native-commands/admit",
        { client: "worker", json: admission, status: 401 },
      );
    }
    const admitted = await h.visit(
      "HTTP native admit " + chat,
      "POST",
      "/api/internal/native-commands/admit",
      { ...auth, json: admission },
    );
    result[chat] = {
      operationId,
      operationGeneration: admitted.receipt.operationGeneration,
      executionLaneId: admitted.receipt.executionLaneId,
      activationGeneration: admitted.receipt.activationGeneration,
      session,
      threadId,
      projectId,
    };
    if (chat !== agent) {
      assert.equal(admitted.receipt.status, "rejected");
      assert.equal(
        admitted.receipt.rejectionCode,
        "managed-session-ineligible",
      );
      assert.equal(admitted.computerUseAuthority, null);
      continue;
    }
    assert.equal(admitted.receipt.status, "accepted");
    const replay = await h.visit(
      "HTTP native admission replay",
      "POST",
      "/api/internal/native-commands/admit",
      { ...auth, json: admission },
    );
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.receipt, admitted.receipt);
    assert.deepEqual(
      replay.computerUseAuthority,
      admitted.computerUseAuthority,
    );
    assert.equal(admitted.computerUseAuthority.chatId, agent);
    assert.equal(
      admitted.computerUseAuthority.executionLaneId,
      admitted.receipt.executionLaneId,
    );
    assert.equal(admitted.computerUseAuthority.ownerId, h.owner);
    assert.equal(admitted.computerUseAuthority.serverId, h.serverId);
    const dispatch = {
      workerId: worker,
      operationId,
      operationGeneration: admitted.receipt.operationGeneration,
      payloadDigest: "a".repeat(64),
      session,
    };
    const bound = await h.visit(
      "HTTP native preparation",
      "POST",
      "/api/internal/native-commands/bind-preparation",
      { ...auth, json: dispatch },
    );
    assert.equal(
      bound.receipt.operationGeneration,
      dispatch.operationGeneration,
    );
    const dispatched = await h.visit(
      "HTTP native dispatch",
      "POST",
      "/api/internal/native-commands/dispatch",
      { ...auth, json: dispatch },
    );
    assert.equal(dispatched.receipt.status, "dispatched");
    assert.deepEqual(
      dispatched.computerUseAuthority,
      admitted.computerUseAuthority,
    );
  }
  return result;
}
