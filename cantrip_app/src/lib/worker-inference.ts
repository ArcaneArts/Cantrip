import type { WorkerInferenceStatus } from "@cantrip/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getWorkerInferenceStatus } from "./api/workers";

export const workerInferenceQueryKey = (workerId: string) =>
  ["worker-inference", workerId] as const;

/** Initial/reconnect snapshots use HTTP; ordinary changes arrive through Live.
 * Consumers select their own chat/pool so another project's activity need not
 * redraw a transcript. No capacity polling or timers run while idle. */
export function useWorkerInference<T = WorkerInferenceStatus>({
  workerId,
  enabled = true,
  select,
}: {
  workerId: string | null;
  enabled?: boolean;
  select?: (status: WorkerInferenceStatus) => T;
}) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: workerInferenceQueryKey(workerId ?? ""),
    enabled: enabled && Boolean(workerId),
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    queryFn: async ({ signal }) => {
      const status = await getWorkerInferenceStatus(workerId!, signal);
      const current = queryClient.getQueryData<WorkerInferenceStatus>(
        workerInferenceQueryKey(workerId!),
      );
      return current?.workerGeneration === status.workerGeneration &&
        current.revision > status.revision
        ? current
        : status;
    },
    select,
  });
}
