import {
  workerLogStreamServerMessageSchema,
  type ServiceLogLevel,
  type WorkerLogStreamServerMessage,
} from "@cantrip/protocol";

export function workerLogStreamWebSocketUrl(
  serverUrl: string,
  browserOrigin: string,
  workerId: string,
  afterCursor: number,
  minimumLevel: ServiceLogLevel,
): string {
  const url = new URL(
    `/api/workers/${encodeURIComponent(workerId)}/logs/stream`,
    serverUrl || browserOrigin,
  );
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else throw new Error("Worker log streaming requires HTTP or HTTPS.");
  url.searchParams.set("afterCursor", String(afterCursor));
  url.searchParams.set("minimumLevel", minimumLevel);
  return url.toString();
}

export function parseWorkerLogStreamMessage(
  value: string,
): WorkerLogStreamServerMessage {
  return workerLogStreamServerMessageSchema.parse(JSON.parse(value));
}

export function workerLogPageAction(input: {
  hasMore: boolean;
  remote: boolean;
  streamFailures: number;
}): "catch-up" | "poll" | "stream" {
  if (input.hasMore) return "catch-up";
  if (input.remote && input.streamFailures < 3) return "stream";
  return "poll";
}
