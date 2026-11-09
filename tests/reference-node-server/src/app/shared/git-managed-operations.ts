import type {
  GitManagedOperationContext,
  GitManagedOperationRecord,
  GitManagedOperationWorkerState,
  GitOperationObservationState,
} from "@cantrip/protocol";

export function gitManagedOperationContext(
  operation: GitManagedOperationRecord,
): GitManagedOperationContext {
  return {
    type: operation.type,
    originalHead: operation.originalHead,
    sourceRef: operation.sourceRef,
    sourceRevision: operation.sourceRevision,
    targetRef: operation.targetRef,
    targetRevision: operation.targetRevision,
    pendingCommits: operation.pendingCommits,
    totalSteps: operation.totalSteps,
    checkpointRef: operation.checkpointRef,
  };
}

export function gitOperationObservationMatches(
  state: GitManagedOperationWorkerState,
  observation: GitOperationObservationState,
): boolean {
  return (
    state.state === observation.state &&
    state.currentHead === observation.currentHead &&
    state.currentStep === observation.currentStep &&
    state.totalSteps === observation.totalSteps &&
    state.pendingCommits.length === observation.pendingCommitCount &&
    state.conflictedPaths.length === observation.conflictedPathCount &&
    (state.pausedAction ?? null) === observation.pausedAction
  );
}
