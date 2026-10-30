import assert from "node:assert/strict";

export async function replicaBlockerCases({ seed, observe, owner, label }) {
  const blocker = async (name, expected) => {
    const results = await observe(name, {
      op: "replica-removal-blocker",
      replica: "source",
      job: "none",
    });
    for (const result of results) assert.equal(result, expected);
  };
  await seed(
    "INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES('extra','source','alpha','Extra','extra-path','extra-display',false,'cantrip','ready')",
  );
  await blocker(
    "additional worktree blocks removal",
    "Remove managed worktrees from this replica before removing it.",
  );
  await seed("DELETE FROM project_worktrees WHERE id='extra'");
  for (const [table, message] of [
    ["terminals", "A terminal is still assigned to this replica."],
    ["explorers", "An Explorer is still assigned to this replica."],
    ["code_tabs", "A Code tab is still assigned to this replica."],
  ]) {
    const state = table === "code_tabs" ? "" : ",protected_state";
    const value = state ? ",'{}'::jsonb" : "";
    await seed(
      `INSERT INTO ${table}(id,project_id,active_worker_id,worktree_id,protected_label${state}) VALUES('blocker','project','alpha','primary',${label}${value})`,
    );
    await blocker(`${table} blocks removal`, message);
    await seed(`DELETE FROM ${table} WHERE id='blocker'`);
    await blocker(`${table} removal releases replica`, null);
  }
  await seed(
    `INSERT INTO project_views(id,project_id,kind,worktree_id,protected_label) VALUES('blocker','project','history','primary',${label})`,
  );
  await blocker(
    "project view blocks removal",
    "A project view is still assigned to this replica.",
  );
  await seed("DELETE FROM project_views WHERE id='blocker'");
  await seed(
    `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label) VALUES('blocker','${owner}','project','primary','alpha',${label})`,
  );
  await blocker(
    "chat blocks removal",
    "A chat is still assigned to this replica.",
  );
  // Keep the chat on another valid worktree so the lane is the sole blocker.
  await seed(
    "INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES('lane-chat-worktree','second','beta','Primary','other-path','other-display',true,'cantrip','ready')",
  );
  await seed(
    "UPDATE chats SET active_worktree_id='lane-chat-worktree',active_worker_id='beta' WHERE id='blocker'",
  );
  await seed(
    "INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,state) VALUES('blocker','blocker','primary','alpha','fixture','active')",
  );
  await blocker(
    "active lane blocks removal",
    "An execution lane is still using this replica.",
  );
  await seed(
    "UPDATE chat_execution_lanes SET state='released',released_at=now() WHERE id='blocker'",
  );
  await blocker("released lane permits removal", null);
  await seed("DELETE FROM chats WHERE id='blocker'");
  await seed("DELETE FROM project_worktrees WHERE id='lane-chat-worktree'");
}
