import { invoke, isTauri } from "@tauri-apps/api/core";
import { listDesktopWorkers, type DesktopWorkerStatus } from "./desktop-worker";
import {
  serviceLogReadResultSchema,
  type ServiceLogLevel,
  type ServiceLogReadResult,
} from "@cantrip/protocol";

export type LocalServiceLogSource =
  | { source: "client" }
  | { source: "server" }
  | { source: "worker" }
  | { source: "linkedWorker"; workerId: string };

export async function getLocalRuntimeServerUrl(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string>("local_server_url");
}

export async function openLocalLogsDirectory(): Promise<void> {
  if (!isTauri())
    throw new Error("Local log folders require the Cantrip desktop app.");
  await invoke("open_local_logs_directory");
}

export function logDumpSources(
  serverUrl: string,
  localServerUrl: string | null,
  workers: readonly DesktopWorkerStatus[],
): LocalServiceLogSource[] {
  const origin = (url: string) => {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  };
  const activeOrigin = origin(serverUrl);
  const sources: LocalServiceLogSource[] = [{ source: "client" }];
  if (
    activeOrigin &&
    localServerUrl &&
    activeOrigin === origin(localServerUrl)
  ) {
    sources.push({ source: "server" }, { source: "worker" });
  }
  for (const worker of workers) {
    if (activeOrigin && origin(worker.serverUrl) === activeOrigin) {
      sources.push({ source: "linkedWorker", workerId: worker.workerId });
    }
  }
  return sources;
}

export async function dumpLocalLogs(serverUrl: string): Promise<{
  directory: string;
  files: string[];
  warnings: string[];
}> {
  if (!isTauri())
    throw new Error("Dump logs requires the Cantrip desktop app.");
  const [local, workers] = await Promise.allSettled([
    getLocalRuntimeServerUrl(),
    listDesktopWorkers(),
  ]);
  const result = await invoke<{
    directory: string;
    files: string[];
    warnings: string[];
  }>("dump_local_logs", {
    sources: logDumpSources(
      serverUrl,
      local.status === "fulfilled" ? local.value : null,
      workers.status === "fulfilled" ? workers.value : [],
    ),
  });
  if (local.status === "rejected")
    result.warnings.push("Could not discover local server logs.");
  if (workers.status === "rejected")
    result.warnings.push("Could not discover linked worker logs.");
  return result;
}

export async function readLocalServiceLogs(
  source: LocalServiceLogSource,
  options: {
    afterCursor?: number;
    beforeCursor?: number;
    limit?: number;
    minimumLevel?: ServiceLogLevel;
  } = {},
): Promise<ServiceLogReadResult> {
  if (!isTauri()) {
    throw new Error("Local runtime logs require the Cantrip desktop app.");
  }
  const result = await invoke("read_local_service_logs", {
    request: { ...source, ...options },
  });
  return serviceLogReadResultSchema.parse(result);
}
