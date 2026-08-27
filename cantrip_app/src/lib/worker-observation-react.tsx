import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  type PropsWithChildren,
} from "react";

import {
  type WorkerObservationClient,
  type WorkerObservationDemand,
} from "./worker-observation-client";

const WorkerObservationContext = createContext<WorkerObservationClient | null>(
  null,
);

export function WorkerObservationProvider({
  children,
  client,
}: PropsWithChildren<{ client: WorkerObservationClient }>) {
  return (
    <WorkerObservationContext.Provider value={client}>
      {children}
    </WorkerObservationContext.Provider>
  );
}

export function useWorkerObservationDemands(
  demands: readonly WorkerObservationDemand[],
): void {
  const client = useContext(WorkerObservationContext);
  useEffect(() => {
    if (!client || demands.length === 0) return;
    return client.retainDemands(demands);
  }, [client, demands]);
}

interface CachedChatSummary {
  activeWorkerId: string | null;
  status: string;
}

function retainableChatWorkerIds(value: unknown, target: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const chat = candidate as Partial<CachedChatSummary>;
    if (
      typeof chat.activeWorkerId === "string" &&
      (chat.status === "running" || chat.status === "waiting-for-approval")
    ) {
      target.add(chat.activeWorkerId);
    }
  }
}

export function runningChatWorkerObservationDemands(
  queryClient: QueryClient,
): WorkerObservationDemand[] {
  const workerIds = new Set<string>();
  for (const query of queryClient
    .getQueryCache()
    .findAll({ queryKey: ["chats"] })) {
    retainableChatWorkerIds(query.state.data, workerIds);
  }
  retainableChatWorkerIds(
    queryClient.getQueryData(["standalone-chats"]),
    workerIds,
  );
  return [...workerIds]
    .sort()
    .map((workerId) => ({ workerId, topics: ["chat-progress"] }));
}

function isChatInventoryQuery(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === "chats" || queryKey[0] === "standalone-chats";
}

export function WorkerObservationBackgroundDemandSession() {
  const client = useContext(WorkerObservationContext);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!client) return;
    const releases = new Map<string, () => void>();
    const synchronize = () => {
      const desired = new Set(
        runningChatWorkerObservationDemands(queryClient).map(
          ({ workerId }) => workerId,
        ),
      );
      for (const [workerId, release] of releases) {
        if (desired.has(workerId)) continue;
        release();
        releases.delete(workerId);
      }
      for (const workerId of desired) {
        if (releases.has(workerId)) continue;
        releases.set(
          workerId,
          client.retainDemands([{ workerId, topics: ["chat-progress"] }]),
        );
      }
    };
    synchronize();
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (isChatInventoryQuery(event.query.queryKey)) synchronize();
    });
    return () => {
      unsubscribe();
      for (const release of releases.values()) release();
    };
  }, [client, queryClient]);
  return null;
}
