import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import type { WorkerInferenceStatus } from "@cantrip/protocol";
import { getWorkers } from "@/lib/api/worker-wire";
import { useWorkerInference } from "@/lib/worker-inference";

function WorkerUsage({
  providerId,
  workerId,
  name,
  online,
}: {
  providerId: string;
  workerId: string;
  name: string;
  online: boolean;
}) {
  const status = useWorkerInference({
    workerId,
    enabled: online,
    select: useCallback(
      (snapshot: WorkerInferenceStatus) => {
        const pool = snapshot.pools.find(
          (pool) => pool.providerId === providerId,
        );
        return pool
          ? {
              active: pool.activeCount,
              queued: pool.queuedCount,
              recovering: pool.operations.filter(
                (operation) => operation.state === "recovering",
              ).length,
              limit: pool.maxConcurrentInference,
            }
          : null;
      },
      [providerId],
    ),
  });
  return (
    <p className="text-xs text-muted-foreground">
      {name}:{" "}
      {!online
        ? "Offline"
        : status.isPending
          ? "Loading inference status…"
          : !status.isError && status.data
            ? `${status.data.active}/${status.data.limit} active, ${status.data.queued} queued${status.data.recovering ? `, ${status.data.recovering} recovering` : ""}`
            : "Inference status unavailable"}
    </p>
  );
}

export function ProviderInferenceUsage({ providerId }: { providerId: string }) {
  const workers = useQuery({ queryKey: ["workers"], queryFn: getWorkers });
  if (!workers.data?.length) return null;
  return (
    <section
      aria-label="Inference capacity by worker"
      className="space-y-1 px-3 py-3"
    >
      <p className="text-sm font-medium">Inference capacity</p>
      {workers.data.map((worker) => (
        <WorkerUsage
          key={worker.workerId}
          providerId={providerId}
          workerId={worker.workerId}
          name={worker.name}
          online={worker.online}
        />
      ))}
    </section>
  );
}
