import type {
  TaskOperationKind,
  TaskStableState,
  TaskState,
} from "@cantrip/protocol/tasks";

const transitions: Readonly<Record<TaskState, readonly TaskState[]>> = {
  draft: ["planning", "implementing"],
  planning: ["review", "failed"],
  review: ["planning", "finalizing"],
  finalizing: ["implementing", "failed"],
  implementing: ["paused", "blocked", "complete", "failed"],
  paused: ["implementing", "blocked", "complete", "failed"],
  blocked: ["implementing", "complete", "failed"],
  complete: [],
  failed: ["planning", "finalizing", "implementing", "paused", "blocked"],
};

export class TaskStateTransitionError extends Error {
  constructor(
    readonly from: TaskState,
    readonly to: TaskState,
  ) {
    super(`A Task cannot transition from ${from} to ${to}.`);
  }
}

export function canTransitionTaskState(
  from: TaskState,
  to: TaskState,
): boolean {
  return transitions[from].includes(to);
}

export function assertTaskStateTransition(
  from: TaskState,
  to: TaskState,
): void {
  if (!canTransitionTaskState(from, to)) {
    throw new TaskStateTransitionError(from, to);
  }
}

export function taskOperationState(kind: TaskOperationKind): TaskState {
  if (kind === "direct") return "implementing";
  return kind === "finalize" ? "finalizing" : "planning";
}

export function taskOperationStableState(
  kind: TaskOperationKind,
): TaskStableState {
  return kind === "direct" || kind === "initial-plan" ? "draft" : "review";
}

export function taskRetryState(
  stableState: TaskStableState,
  operationKind: TaskOperationKind,
): TaskState {
  if (operationKind === "direct") {
    if (stableState !== "draft") {
      throw new TaskStateTransitionError("failed", "implementing");
    }
    return "implementing";
  }
  if (operationKind === "finalize") {
    if (stableState !== "review") {
      throw new TaskStateTransitionError("failed", "finalizing");
    }
    return "finalizing";
  }
  if (
    (operationKind === "initial-plan" && stableState !== "draft") ||
    (operationKind === "continue-plan" && stableState !== "review")
  ) {
    throw new TaskStateTransitionError("failed", "planning");
  }
  return "planning";
}

export function validateTaskOperationStart(
  state: TaskState,
  stableStateBeforeFailure: TaskStableState | null,
  kind: TaskOperationKind,
): { nextState: TaskState; stableState: TaskStableState } {
  const stableState = taskOperationStableState(kind);
  const nextState = taskOperationState(kind);
  if (state === "failed") {
    if (!stableStateBeforeFailure) {
      throw new TaskStateTransitionError(state, nextState);
    }
    taskRetryState(stableStateBeforeFailure, kind);
    return { nextState, stableState: stableStateBeforeFailure };
  }
  if (state !== stableState) {
    throw new TaskStateTransitionError(state, nextState);
  }
  assertTaskStateTransition(state, nextState);
  return { nextState, stableState };
}
