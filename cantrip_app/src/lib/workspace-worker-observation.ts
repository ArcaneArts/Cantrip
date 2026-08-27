import {
  mergeWorkerObservationDemands,
  type WorkerObservationDemand,
} from "./worker-observation-client";

export interface WorkspaceWorkerObservationInput {
  projectBroadWorkerIds: readonly (string | null | undefined)[];
  projectChatWorkerId: string | null | undefined;
  projectFilesystemWorkerIds: readonly (string | null | undefined)[];
  projectVisible: boolean;
  standaloneChatWorkerId: string | null | undefined;
}

export function workspaceWorkerObservationDemands({
  projectBroadWorkerIds,
  projectChatWorkerId,
  projectFilesystemWorkerIds,
  projectVisible,
  standaloneChatWorkerId,
}: WorkspaceWorkerObservationInput): WorkerObservationDemand[] {
  const demands: WorkerObservationDemand[] = [];
  const add = (
    workerId: string | null | undefined,
    topics: WorkerObservationDemand["topics"],
  ) => {
    if (workerId) demands.push({ topics, workerId });
  };
  if (projectVisible) {
    const broadTopics = ["filesystem", "worktree", "runtime"] as const;
    for (const workerId of projectBroadWorkerIds) add(workerId, broadTopics);
    for (const workerId of projectFilesystemWorkerIds) {
      add(workerId, ["filesystem", "worktree"]);
    }
    add(projectChatWorkerId, ["chat-progress", ...broadTopics]);
  }
  add(standaloneChatWorkerId, ["chat-progress"]);
  return mergeWorkerObservationDemands(demands);
}
