import assert from "node:assert/strict";
import {
  argumentsFor,
  target,
  interaction,
} from "./agent-surface-http-fixtures.mjs";
import { literal, json, label, state, stamp } from "./project-target-state.mjs";
import {
  settingsChat as chat,
  settingsProject as project,
  settingsWorker as worker,
  settingsTree as tree,
} from "./native-settings-http-fixture.mjs";

export async function surfaceIsolationCases(c) {
  const { h, call, result, state: peer, binding } = c;
  const foreign = "eeeeeeee-eeee-4eee-8eee-000000000820";
  await h.fixture.sql([
    `INSERT INTO users(id,kind,display_name,email,normalized_email) VALUES(${literal(foreign)},'account','Surface foreign owner','foreign-surface@example.invalid','foreign-surface@example.invalid')`,
    `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES('surface-foreign-worker',${literal(foreign)},'Foreign worker','linux','x64',${literal(stamp)},${literal(stamp)})`,
  ]);
  for (const [id, owner, workerId] of [
    ["other-owned-surface-project", h.owner, worker],
    ["foreign-surface-project", foreign, "surface-foreign-worker"],
  ]) {
    const root = id + "-root";
    await h.fixture.sql([
      `INSERT INTO projects(id,owner_id,protected_label,origin_kind,git_capability,github_capability,worktree_policy,preferred_worker_id,github_repository_blind_index) VALUES(${literal(id)},${literal(owner)},${json(label("project"))},'github',true,true,'agent-managed',${literal(workerId)},${literal(id)})`,
      `INSERT INTO project_sources(id,project_id,worker_id,source_kind,absolute_path,display_path) VALUES(${literal(id + "-source")},${literal(id)},${literal(workerId)},'git','/isolated-surface','/isolated-surface')`,
      `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES(${literal(root)},${literal(id + "-source")},${literal(workerId)},'main','/isolated-surface','/isolated-surface',true,'cantrip','ready')`,
      ...[
        ["explorers", "explorer", "explorer-state"],
        ["terminals", "terminal", "terminal-state"],
      ].map(
        ([table, kind, protection]) =>
          `INSERT INTO ${table}(id,project_id,active_worker_id,worktree_id,protected_label,protected_state) VALUES(${literal(id + "-" + kind)},${literal(id)},${literal(workerId)},${literal(root)},${json(label(kind))},${json(state(protection))})`,
      ),
    ]);
    for (const op of [
      "explorer.list",
      "explorer.read",
      "explorer.write",
      "terminal.read",
      "terminal.send",
      "terminal.restart",
    ]) {
      const before = peer.commands.length;
      await call(
        "isolated target " + id + " " + op,
        op,
        {
          ...argumentsFor(op),
          target: target(op.split(".")[0], id + "-" + op.split(".")[0]),
        },
        409,
      );
      assert.equal(peer.commands.length, before);
      assert.equal(result.calls.at(-1).events.length, 0);
    }
  }
  const otherChat = "eeeeeeee-eeee-4eee-8eee-000000000821";
  await h.fixture.sql([
    `INSERT INTO chats(id,owner_id,project_id,active_worker_id,active_worktree_id,protected_label) VALUES(${literal(otherChat)},${literal(h.owner)},${literal(project)},${literal(worker)},${literal(tree)},${json(label("chat"))})`,
  ]);
  for (const [name, sql, restore] of [
    [
      "other chat",
      `UPDATE agent_interaction_requests SET chat_id=${literal(otherChat)} WHERE id=${literal(interaction)}`,
      `UPDATE agent_interaction_requests SET chat_id=${literal(chat)} WHERE id=${literal(interaction)}`,
    ],
    [
      "other project",
      `UPDATE agent_interaction_requests SET project_id='other-owned-surface-project' WHERE id=${literal(interaction)}`,
      `UPDATE agent_interaction_requests SET project_id=${literal(project)} WHERE id=${literal(interaction)}`,
    ],
    [
      "foreign owner",
      `UPDATE agent_interaction_requests SET owner_id=${literal(foreign)},chat_id=NULL,project_id='foreign-surface-project',worker_id='surface-foreign-worker' WHERE id=${literal(interaction)}`,
      `UPDATE agent_interaction_requests SET owner_id=${literal(h.owner)},chat_id=${literal(chat)},project_id=${literal(project)},worker_id=${literal(worker)} WHERE id=${literal(interaction)}`,
    ],
  ]) {
    await h.fixture.sql([sql]);
    try {
      const body = await call(
        "interaction isolates " + name,
        "client.show-interaction",
        { interactionId: interaction },
        400,
      );
      assert.deepEqual(body, {
        code: "invalid",
        error: "The interaction is not pending in the bound Cantrip chat.",
      });
      assert.equal(result.calls.at(-1).commands.length, 0);
    } finally {
      await h.fixture.sql([restore]);
    }
  }
  // Capability and ownership denials run before argument or endpoint handling.
  for (const operation of [
    "explorer.write",
    "terminal.send",
    "browser.open",
    "client.notify",
  ]) {
    await call("foreign binding denied " + operation, operation, {}, 403, {
      ...binding,
      ownerId: foreign,
    });
    assert.equal(result.calls.at(-1).commands.length, 0);
  }
}
