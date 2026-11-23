import type { McpServerConfiguration, WorkerCommand } from "@cantrip/protocol";
import type { RuntimeProvider } from "./codex/external-chatgpt-auth.js";
import type { RuntimeSubagentDefaults } from "./codex/runtime-types.js";

type TaskGoalCommand = Extract<
  WorkerCommand,
  { type: "chat.goal.create" | "chat.goal.update" }
>;
type SubagentDefaults = Extract<
  WorkerCommand,
  { type: "task.goal.recover" }
>["subagentDefaults"];

/** Use the exact root account for children, just as ordinary Task execution does. */
export async function openTaskGoalSubagentDefaults(
  defaults: SubagentDefaults,
  root: RuntimeProvider,
  openProvider: (
    provider: NonNullable<SubagentDefaults>["provider"],
  ) => Promise<RuntimeProvider>,
): Promise<RuntimeSubagentDefaults | null> {
  if (!defaults) return null;
  const provider = await openProvider(defaults.provider);
  if (
    provider.id !== root.id ||
    provider.kind !== root.kind ||
    provider.accountId !== root.accountId ||
    provider.credentialHomeKey !== root.credentialHomeKey
  )
    throw new Error(
      "Custom subagents must use the root model's provider identity.",
    );
  return { model: defaults.model, provider };
}

/** Configuration only; actual inference still enters the worker/native gate.
 * Pause/objective/clear metadata controls never need to resume a Task Core. */
export async function taskGoalRuntimeConfiguration(
  command: TaskGoalCommand,
  provider: RuntimeProvider,
  dependencies: {
    openProvider: Parameters<typeof openTaskGoalSubagentDefaults>[2];
    mcpServers: (
      scope: NonNullable<TaskGoalCommand["taskRuntime"]>,
      configured: NonNullable<TaskGoalCommand["mcpServers"]>,
    ) => Promise<McpServerConfiguration[]>;
  },
) {
  const activatingTask =
    command.type === "chat.goal.create"
      ? typeof command.objective !== "string"
      : Boolean(command.taskContext) && command.status === "active";
  if (!activatingTask) return null;
  if (
    !command.taskContext ||
    command.session ||
    !command.taskRuntime ||
    command.subagentDefaults === undefined ||
    command.mcpServers === undefined ||
    command.planMode === undefined
  )
    throw new Error(
      "Task Goal activation requires its full runtime configuration.",
    );
  const { taskRuntime, osExecution } = command;
  if (
    osExecution &&
    (osExecution.scope.projectId !== taskRuntime.projectId ||
      osExecution.scope.worktreeId !== taskRuntime.worktreeId ||
      (osExecution.scope.sourceKind === "git"
        ? "git-worktree"
        : "folder-root") !== taskRuntime.rootKind)
  )
    throw new Error(
      "The Task Goal differs from its captured OS project/worktree.",
    );
  const subagentDefaults = await openTaskGoalSubagentDefaults(
    command.subagentDefaults,
    provider,
    dependencies.openProvider,
  );
  return {
    projectId: taskRuntime.projectId,
    subagentDefaults,
    planMode: command.planMode,
    mcpServers: await dependencies.mcpServers(taskRuntime, command.mcpServers),
  };
}
