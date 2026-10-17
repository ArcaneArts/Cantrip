import { reconcileProjectObservationPaths } from "../project-source-path.js";
import { workerLogger, workerLogError } from "../logger.js";
import type { WorkerCommand } from "@cantrip/protocol";
import type { WorktreeManager } from "../worktrees.js";
import type { RunConfigurationRuntimeSupervisor } from "../run-configuration-runtime-supervisor.js";
import type { CodeGraphObservationCoordinator } from "../codegraph/observations.js";
import type { CodeGraphProjectSupervisor } from "../codegraph/supervisor.js";

export type WorktreeCommand = Extract<
  WorkerCommand,
  {
    type:
      | "worktree.list"
      | "worktree.reconcile"
      | "worktree.create"
      | "worktree.remove"
      | "worktree.lock"
      | "worktree.unlock"
      | "worktree.prune"
      | "worktree.status"
      | "worktree.observation.configure";
  }
>;
export interface WorktreeCommandDependencies {
  worktrees: Pick<
    WorktreeManager,
    | "list"
    | "reconcile"
    | "create"
    | "remove"
    | "lock"
    | "unlock"
    | "prune"
    | "status"
    | "configureObservation"
  >;
  runConfigurationRuntimes: Pick<
    RunConfigurationRuntimeSupervisor,
    "stopForPath"
  >;
  codegraphObservations: Pick<
    CodeGraphObservationCoordinator,
    "forgetPath" | "configure"
  >;
  getCodegraphProjects: () => CodeGraphProjectSupervisor | null;
}

// Services are owned by the worker entry point; this handler only executes commands.
export async function handleWorktreeCommand(
  command: WorktreeCommand,
  dependencies: WorktreeCommandDependencies,
): Promise<unknown> {
  const {
    worktrees,
    runConfigurationRuntimes,
    codegraphObservations,
    getCodegraphProjects,
  } = dependencies;
  switch (command.type) {
    case "worktree.list":
      return worktrees.list(command.sourcePath);
    case "worktree.reconcile":
      return worktrees.reconcile(command.sourcePath);
    case "worktree.create":
      return worktrees.create(
        command.sourcePath,
        command.worktreeId,
        command.name,
        command.mode,
      );
    case "worktree.remove": {
      const result = await worktrees.remove(
        command.sourcePath,
        command.worktreePath,
        {
          allowExternal: command.allowExternal,
          force: command.force,
          beforeRemove: async (worktreePath) => {
            await runConfigurationRuntimes.stopForPath(worktreePath);
          },
        },
      );
      codegraphObservations.forgetPath(command.worktreePath);
      getCodegraphProjects()?.detach(command.worktreePath);
      return result;
    }
    case "worktree.lock":
      return worktrees.lock(
        command.sourcePath,
        command.worktreePath,
        command.reason,
      );
    case "worktree.unlock":
      return worktrees.unlock(command.sourcePath, command.worktreePath);
    case "worktree.prune": {
      return worktrees.prune(command.sourcePath, command.allowExternal);
    }
    case "worktree.status":
      return worktrees.status(command.sourcePath, command.worktreePath);
    case "worktree.observation.configure": {
      const worktreeObservationPaths = await reconcileProjectObservationPaths(
        command.targets,
      );
      const codegraphObservationPaths = await reconcileProjectObservationPaths(
        command.codegraphTargets ??
          command.targets.map((target) => ({
            projectId: target.projectId!,
            worktreeId: target.worktreeId!,
            rootKind: "git-worktree" as const,
            sourcePath: target.sourcePath,
            worktreePath: target.worktreePath,
          })),
      );
      worktrees.configureObservation(worktreeObservationPaths.targets);
      await codegraphObservations
        .configure(codegraphObservationPaths.targets)
        .catch((error) => {
          workerLogger.event(
            "warn",
            "CodeGraph worktree reconciliation failed",
            {
              event: "codegraph.project.configure-failed",
              subsystem: "codegraph",
              operation: "configure-worktrees",
              reasonCode: "configuration-failed",
              status: "degraded",
              error: workerLogError(error),
            },
          );
        });
      return {
        accepted: true,
        paths: [
          ...new Map(
            [
              ...worktreeObservationPaths.paths,
              ...codegraphObservationPaths.paths,
            ].map((resolved) => [
              `${resolved.projectId}\0${resolved.worktreeId}`,
              resolved,
            ]),
          ).values(),
        ],
      };
    }
  }
}
