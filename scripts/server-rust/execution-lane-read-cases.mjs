import assert from "node:assert/strict";
import { literal, stamp } from "./project-target-state.mjs";
export async function runLaneReadCases({
  start,
  call,
  unchanged,
  seed,
  snapshot,
  standalone,
  other,
}) {
  let c = await start();
  for (const action of ["context", "recovery"]) {
    for (const result of await unchanged("project lane " + action, () =>
      call(action, "project lane " + action, c.key),
    )) {
      assert.equal(result.chat.id, "chat");
      assert.equal(result.lane.contextKind, "project");
      assert.equal(result.worktree.id, "github-alpha-main");
      assert.equal(typeof result.sourcePath, "string");
    }
    for (const extra of [
      { owner: other },
      { chat: "missing" },
      { lane: "missing" },
    ])
      for (const result of await call(
        action,
        "lane read scope " + action + JSON.stringify(extra),
        (i) => c.key(i, extra),
      ))
        assert.equal(result, null);
  }
  for (const list of await call("list-chat", "list current chat lanes")) {
    assert.equal(list.length, 1);
    assert.equal(list[0].state, "active");
  }
  for (const list of await call("list-project", "list active project lanes", {
    project: "github",
  })) {
    assert.equal(list.length, 1);
    assert.equal(list[0].chatId, "chat");
  }
  await seed([
    `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,state,created_at,updated_at) VALUES('old-released','chat','github-alpha-feature','alpha','agent','released','2000-01-01','2001-01-01')`,
    `UPDATE chats SET archived_at=${literal(stamp)} WHERE id='chat'`,
    `UPDATE project_sources SET removed_at=${literal(stamp)} WHERE id='github-alpha'`,
  ]);
  for (const result of await call(
    "context",
    "lane context preserves historical archived removed replica scope",
    c.key,
  ))
    assert.equal(result.worktree.id, "github-alpha-main");
  for (const list of await call("list-chat", "chat history ordering"))
    assert.deepEqual(
      list.map((l) => l.state),
      ["active", "released"],
    );
  for (const list of await call(
    "list-project",
    "project current excludes released",
    { project: "github" },
  ))
    assert.equal(list.length, 1);
  for (const list of await call(
    "list-project",
    "project complete lane history",
    { project: "github", includeHistory: true },
  ))
    assert.deepEqual(
      list.map((l) => l.state),
      ["active", "released"],
    );
  for (const extra of [{ owner: other }, { project: "missing" }])
    for (const list of await call(
      "list-project",
      "project lane owner scope " + JSON.stringify(extra),
      { project: "github", ...extra },
    ))
      assert.deepEqual(list, []);
  c = await start({ chat: standalone });
  for (const result of await call(
    "context",
    "standalone is outside project lane context",
    c.key,
  ))
    assert.equal(result, null);
  for (const result of await call(
    "recovery",
    "standalone recovery exact protected root",
    c.key,
  )) {
    assert.equal(result.chat.contextKind, "standalone");
    assert.equal(result.lane.contextKind, "standalone");
    assert.equal(
      result.root.pathHandle,
      "ctrr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    assert.equal(result.root.workerId, "alpha");
  }
  for (const list of await call("list-chat", "project list omits standalone", {
    chat: standalone,
  }))
    assert.deepEqual(list, []);
  await seed(
    "UPDATE standalone_chat_roots SET status='provisioning',protected_path_handle=NULL",
  );
  for (const result of await call(
    "recovery",
    "no standalone recovery without protected root",
    c.key,
  ))
    assert.equal(result, null);
  c = await start();
  await seed(
    "UPDATE chat_execution_lanes SET created_at='infinity' WHERE chat_id='chat'",
  );
  await unchanged("invalid lane date conversion", () =>
    call("list-chat", "invalid lane date conversion", {}, { error: true }),
  );
  c = await start();
  await seed(
    "UPDATE project_worktrees SET lifecycle_state='failed' WHERE id='github-alpha-main'",
  );
  for (const result of await call(
    "recovery",
    "recovery can inspect unready project worktree",
    c.key,
  ))
    assert.equal(result.worktree.lifecycleState, "failed");
  await snapshot("remaining reads complete");
}
