import { invoke, isTauri } from "@tauri-apps/api/core";
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

export async function readLocalServiceLogs(
  source: LocalServiceLogSource,
  options: {
    afterCursor?: number;
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
