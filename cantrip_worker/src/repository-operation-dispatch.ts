import {
  gitCommitActionResultSchema,
  gitManagedOperationResponseSchema,
  gitManagedOperationWorkerStateSchema,
  gitStashMutationResultSchema,
  gitWorktreeChangesMoveResultSchema,
  workerCommandSchema,
  type GitManagedOperationContext,
  type GitManagedOperationWorkerState,
  type GitCommitActionResult,
  type GitStashMutationResult,
  type WorkerCommand,
} from "@cantrip/protocol";
import type {
  RepositoryOperationRequestContent,
  RepositoryOperationOutcomeContent,
} from "@cantrip/protocol/repository-operation";
import {
  managedOperationContext,
  managedOperationIsActive,
  managedOperationRecord,
  RepositoryManagedOperationStore,
  type RepositoryManagedOperationScope,
} from "./repository-managed-operation-store.js";
import { githubOperationRequiresCheckout } from "./github-operation-scope.js";

function commitManagedOperationState(
  result: GitCommitActionResult,
): GitManagedOperationWorkerState | null {
  if (!result.operation) return null;
  const operation = result.operation;
  const context: GitManagedOperationContext = {
    type: operation.type,
    originalHead: operation.originalHead,
    sourceRef: null,
    sourceRevision: operation.sourceRevisions[0] ?? null,
    targetRef: result.status.branch
      ? `refs/heads/${result.status.branch}`
      : null,
    targetRevision: operation.originalHead,
    pendingCommits: operation.sourceRevisions,
    totalSteps: operation.totalSteps,
    checkpointRef: result.checkpointRef,
  };
  return gitManagedOperationWorkerStateSchema.parse({
    ...context,
    state: operation.state,
    currentHead: operation.currentHead,
    currentStep: operation.currentStep,
    pendingCommits:
      operation.state === "completed"
        ? []
        : operation.sourceRevisions.slice(
            Math.max(0, operation.currentStep - 1),
          ),
    conflictedPaths: operation.conflictedPaths,
    output: result.output,
    status: result.status,
  });
}

function stashManagedOperationState(
  result: GitStashMutationResult,
): GitManagedOperationWorkerState | null {
  if (!result.operation) return null;
  return gitManagedOperationWorkerStateSchema.parse({
    ...result.operation,
    state: "conflicted",
    output: result.output,
    status: result.status,
  });
}

function repositoryMutationRequiresIdleState(type: string): boolean {
  return (
    type === "git.action" ||
    type === "git.commit.action.preview" ||
    type === "git.commit.action.apply" ||
    type === "git.stash.create" ||
    type === "git.stash.action.preview" ||
    type === "git.stash.action.apply" ||
    (type.endsWith(".apply") &&
      ![
        "git.conflicts.apply",
        "git.operation.control",
        "git.operation.amend",
      ].includes(type))
  );
}

export async function dispatchRepositoryOperation({
  command,
  request,
  scope,
  store,
  inspect,
  repositoryForCheckout,
  dispatch,
}: {
  command: Extract<WorkerCommand, { type: "repository.operation" }>;
  request: RepositoryOperationRequestContent;
  scope: RepositoryManagedOperationScope;
  store: RepositoryManagedOperationStore;
  inspect: (
    cwd: string,
    context: GitManagedOperationContext,
  ) => Promise<GitManagedOperationWorkerState>;
  repositoryForCheckout: (cwd: string) => Promise<string | null>;
  dispatch: (command: WorkerCommand) => Promise<unknown>;
}): Promise<RepositoryOperationOutcomeContent> {
  let stored = await store.get(scope);
  const refreshStoredOperation = async () => {
    if (!managedOperationIsActive(stored)) return stored;
    const state = await inspect(command.cwd, managedOperationContext(stored!));
    stored = managedOperationRecord({
      existing: stored,
      scope,
      state,
    });
    await store.put(scope, stored);
    return stored;
  };
  if (request.type === "git.operation.current") {
    return {
      ok: true,
      result: gitManagedOperationResponseSchema.parse({
        operation: await refreshStoredOperation(),
      }),
    };
  } else {
    if (
      (repositoryMutationRequiresIdleState(request.type) ||
        request.type === "git.operation.preview" ||
        request.type === "git.operation.start") &&
      managedOperationIsActive(stored)
    ) {
      throw new Error("Finish or abort the active Git operation first.");
    }
    const operationId = request.arguments.operationId;
    if (
      ["git.operation.control", "git.operation.amend"].includes(request.type)
    ) {
      if (
        !stored ||
        !managedOperationIsActive(stored) ||
        typeof operationId !== "string" ||
        operationId !== stored.id
      ) {
        throw new Error("Git operation not found.");
      }
    }
    const requiresGithubCheckout = githubOperationRequiresCheckout(
      request.type,
    );
    const repository =
      command.repository ??
      (requiresGithubCheckout
        ? await repositoryForCheckout(command.cwd)
        : null);
    if (requiresGithubCheckout && !repository) {
      throw new Error(
        "This checkout does not have a GitHub origin available to the worker.",
      );
    }
    const isWorktreeChangesMove =
      request.type === "git.worktree.changes.preview" ||
      request.type === "git.worktree.changes.apply";
    if (isWorktreeChangesMove) {
      if (
        !command.peerWorktree ||
        request.arguments.request === null ||
        typeof request.arguments.request !== "object" ||
        (request.arguments.request as { sourceWorktreeId?: unknown })
          .sourceWorktreeId !== command.peerWorktree.id
      ) {
        throw new Error(
          "The protected source worktree does not match the routed peer worktree.",
        );
      }
    } else if (command.peerWorktree) {
      throw new Error(
        "A peer worktree is only valid for a worktree changes move.",
      );
    }
    const trustedCommand = workerCommandSchema.parse({
      ...request.arguments,
      type: request.type,
      cwd: command.cwd,
      sourcePath: command.sourcePath,
      worktreePath: command.cwd,
      repository,
      ...(isWorktreeChangesMove
        ? { sourceCwd: command.peerWorktree!.cwd }
        : {}),
      ...(["git.operation.control", "git.operation.amend"].includes(
        request.type,
      )
        ? { context: managedOperationContext(stored!) }
        : {}),
    });
    if (trustedCommand.type === "repository.operation") {
      throw new Error("Nested repository operations are not allowed.");
    }
    let result = await dispatch(trustedCommand);
    if (
      [
        "git.operation.start",
        "git.operation.control",
        "git.operation.amend",
      ].includes(request.type)
    ) {
      stored = managedOperationRecord({
        existing: request.type === "git.operation.start" ? null : stored,
        id: command.operationId,
        scope,
        state: gitManagedOperationWorkerStateSchema.parse(result),
      });
      await store.put(scope, stored);
      result = gitManagedOperationResponseSchema.parse({
        operation: stored,
      });
    } else if (request.type === "git.commit.action.apply") {
      const parsed = gitCommitActionResultSchema.parse(result);
      const state = commitManagedOperationState(parsed);
      if (state) {
        stored = managedOperationRecord({
          id: command.operationId,
          scope,
          state,
        });
        await store.put(scope, stored);
      }
      result = parsed;
    } else if (request.type === "git.stash.action.apply") {
      const parsed = gitStashMutationResultSchema.parse(result);
      const state = stashManagedOperationState(parsed);
      if (state) {
        stored = managedOperationRecord({
          id: command.operationId,
          scope,
          state,
        });
        await store.put(scope, stored);
      }
      result = parsed;
    } else if (request.type === "git.worktree.changes.apply") {
      const parsed = gitWorktreeChangesMoveResultSchema.parse(result);
      const state = stashManagedOperationState(parsed);
      if (state) {
        stored = managedOperationRecord({
          id: command.operationId,
          scope,
          state,
        });
        await store.put(scope, stored);
      }
      result = parsed;
    } else if (
      request.type === "git.conflicts.apply" &&
      managedOperationIsActive(stored)
    ) {
      await refreshStoredOperation();
    }
    return { ok: true, result };
  }
}
