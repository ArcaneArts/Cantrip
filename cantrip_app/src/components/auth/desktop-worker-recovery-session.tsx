import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import { getWorkerManagement } from "@/lib/api";
import {
  listDesktopWorkerCandidates,
  listDesktopWorkers,
  supportsDesktopWorkers,
} from "@/lib/desktop-worker";
import {
  automaticDesktopWorkerRecoveryPlan,
  connectDesktopWorker,
} from "@/lib/desktop-worker-recovery";
import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";
import { getActiveServerConnection } from "@/lib/server-connections";

export function DesktopWorkerRecoverySession() {
  const queryClient = useQueryClient();
  const attemptedRecoveryRef = useRef<string | null>(null);
  const connection = getActiveServerConnection();
  const serverUrl = connection?.url ?? "";
  const enabled =
    supportsDesktopWorkers() &&
    connection?.kind === "remote" &&
    Boolean(serverUrl);
  const desktopWorkers = useQuery({
    enabled,
    queryFn: listDesktopWorkers,
    queryKey: ["desktop-workers"],
  });
  const candidates = useQuery({
    enabled,
    queryFn: () => listDesktopWorkerCandidates(serverUrl),
    queryKey: ["desktop-worker-candidates", serverUrl],
  });
  const workers = useQuery({
    enabled,
    queryFn: getWorkerManagement,
    queryKey: ["worker-management"],
  });
  const plan = useMemo(
    () =>
      automaticDesktopWorkerRecoveryPlan({
        candidates: candidates.data ?? [],
        desktopWorkers: desktopWorkers.data ?? [],
        serverUrl,
        workers: workers.data ?? [],
      }),
    [candidates.data, desktopWorkers.data, serverUrl, workers.data],
  );

  useEffect(() => {
    if (!plan) return;
    const attemptKey = `${serverUrl}:${plan.currentWorkerId}:${plan.recoveryWorkerId}`;
    if (attemptedRecoveryRef.current === attemptKey) return;
    attemptedRecoveryRef.current = attemptKey;
    clientLogger.info("Retained desktop worker recovery started", {
      event: "desktop.worker.recovery.started",
      operation: "recover-worker",
      status: "started",
      subsystem: "desktop-worker",
      workerId: plan.recoveryWorkerId,
    });
    void connectDesktopWorker({
      candidates: candidates.data ?? [],
      currentWorkerId: plan.currentWorkerId,
      recoveryWorkerId: plan.recoveryWorkerId,
      serverUrl,
      workers: workers.data ?? [],
    })
      .then(async ({ desktopWorker }) => {
        clientLogger.info("Retained desktop worker recovery completed", {
          event: "desktop.worker.recovery.completed",
          operation: "recover-worker",
          status: "completed",
          subsystem: "desktop-worker",
          workerId: desktopWorker.workerId,
        });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["desktop-workers"] }),
          queryClient.invalidateQueries({ queryKey: ["worker-management"] }),
          queryClient.invalidateQueries({ queryKey: ["workers"] }),
        ]);
      })
      .catch((error: unknown) => {
        clientLogger.error("Retained desktop worker recovery failed", {
          ...operationalErrorMetadata(error),
          event: "desktop.worker.recovery.failed",
          operation: "recover-worker",
          reasonCode: "recovery-failed",
          status: "failed",
          subsystem: "desktop-worker",
          workerId: plan.recoveryWorkerId,
        });
      });
  }, [candidates.data, plan, queryClient, serverUrl, workers.data]);

  return null;
}
