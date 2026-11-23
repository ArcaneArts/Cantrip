import {
  codeGraphWorkerStatusSchema,
  type CodeGraphWorkerStatus,
} from "@cantrip/protocol";

import type { CodeGraphRuntimeManager } from "./runtime.js";
import type { CodeGraphProjectSupervisor } from "./supervisor.js";

export function codeGraphWorkerStatus(
  runtime: CodeGraphRuntimeManager | null,
  projects: CodeGraphProjectSupervisor | null,
  preparationError: string | null = null,
): CodeGraphWorkerStatus {
  const status = runtime?.status() ?? null;
  const counts = { ready: 0, indexing: 0, queued: 0, degraded: 0 };
  for (const project of projects?.statuses() ?? []) {
    if (project.state === "ready") counts.ready += 1;
    else if (project.state === "queued") counts.queued += 1;
    else if (project.state === "indexing" || project.state === "syncing")
      counts.indexing += 1;
    else counts.degraded += 1;
  }
  const cliAvailable = status?.cliAvailable === true;
  const message = preparationError ?? status?.error ?? null;
  return codeGraphWorkerStatusSchema.parse({
    supported: runtime !== null,
    available: cliAvailable,
    runtimeState: status?.state ?? "unavailable",
    installedVersion: status?.installedVersion ?? null,
    latestVersion: status?.latestVersion ?? null,
    previousVersion: status?.previousVersion ?? null,
    lastCheckedAt: status?.lastCheckedAt ?? null,
    telemetryDisabled: status?.telemetryDisabled === true,
    healthy:
      cliAvailable && status?.telemetryDisabled === true && message === null,
    statusMessage: message?.slice(0, 1_000) ?? null,
    projectCounts: counts,
    cliAvailable,
    mcpInjectionAvailable: cliAvailable && projects !== null,
  });
}
