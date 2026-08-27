import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { getWorkers } from "@/lib/api";
import { useAppLiveStatus } from "@/lib/app-live-react";
import { liveResourceRefreshInterval } from "@/lib/live-resource-refresh";
import type { WorkerObservationClient } from "@/lib/worker-observation-client";

const WORKER_LIST_FALLBACK_INTERVAL_MS = 30_000;

export function WorkerObservationSession({
  client,
}: {
  client: WorkerObservationClient;
}) {
  const workerResourcesLive = useAppLiveStatus() === "live";
  const workers = useQuery({
    queryFn: getWorkers,
    queryKey: ["workers"],
    refetchInterval: liveResourceRefreshInterval(
      workerResourcesLive,
      WORKER_LIST_FALLBACK_INTERVAL_MS,
    ),
  });
  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);
  useEffect(() => {
    if (!workers.data) return;
    client.updateAvailableWorkers(
      workers.data
        .filter((worker) => worker.online)
        .map((worker) => worker.workerId),
    );
  }, [client, workers.data]);
  return null;
}
