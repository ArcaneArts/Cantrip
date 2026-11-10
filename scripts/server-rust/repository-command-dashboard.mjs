// The Task dashboard retains one direct GitHub command producer in addition to
// the endpoint-protected repository variant. Qualify it explicitly.
import assert from "node:assert/strict";
import { taskImplementationOpaqueDashboardSchema } from "../../packages/protocol/dist/index.js";
import {
  settingsChat as chat,
  settingsProject as project,
} from "./native-settings-http-fixture.mjs";
import { nativeRecoveryGoalContent } from "./native-recovery-http-goal-content.mjs";
import { dashboardPullRequest } from "./task-dashboard-fixtures.mjs";
import { literal, json } from "./project-target-state.mjs";
import { taskTimestamp } from "./task-wire-fixtures.mjs";

export function repositoryCommandDashboard(result) {
  let active = false;
  async function onCommand(command) {
    if (command.type !== "github.pull-requests.list" || !active) return;
    assert.equal(command.repository, "fixture/repository");
    assert.equal(command.limit, 100);
    assert.equal(command.cursor, null);
    assert.ok(["open", "closed"].includes(command.state));
    result.rawDashboardCommands.push(structuredClone(command));
    const pullRequests =
      command.state === "open" ? [dashboardPullRequest(1)] : [];
    return {
      state: command.state,
      total: pullRequests.length,
      pullRequests,
      nextCursor: null,
    };
  }
  async function run(h) {
    const content = nativeRecoveryGoalContent(h, result, chat);
    const task = await content.task(
      "complete",
      1,
      {},
      "dashboard completed Task",
    );
    await h.fixture.sql([
      `UPDATE projects SET task_scheduling_paused=true,task_scheduling_paused_at=${literal(taskTimestamp)},github_repository_full_name='fixture/repository',github_repository_url='https://github.com/fixture/repository' WHERE id=${literal(project)}`,
      `UPDATE chats SET experience='task',automation_paused=true WHERE id=${literal(chat)}`,
      `UPDATE project_worktrees SET branch='task-branch' WHERE id=(SELECT active_worktree_id FROM chats WHERE id=${literal(chat)})`,
      `INSERT INTO tasks(chat_id,state,planning_round,plan_goal_enabled,protected_content,implementation_started_at) VALUES(${literal(chat)},'complete',1,false,${json(task.protectedContent)},${literal(taskTimestamp)})`,
    ]);
    active = true;
    try {
      const value = await h.visit(
        "Task dashboard direct GitHub PR producer",
        "GET",
        `/api/tasks/${chat}/dashboard`,
      );
      taskImplementationOpaqueDashboardSchema.parse(value);
      assert.equal(value.pullRequests.length, 1);
      assert.equal(value.pullRequestsUnavailableReason, null);
      assert.deepEqual(value.task.protectedContent, task.protectedContent);
      await content.prove(value);
      assert.deepEqual(result.rawDashboardCommands.map((c) => c.state).sort(), [
        "closed",
        "open",
      ]);
      result.observations = content.canonical(result.observations);
      content.finish();
      result.dashboardCommands = h.fixture
        .normalize(result.rawDashboardCommands)
        .toSorted((a, b) => (a.state < b.state ? -1 : 1));
    } finally {
      active = false;
    }
  }
  return { onCommand, run };
}
