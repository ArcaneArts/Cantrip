import os from "node:os";
import path from "node:path";

export interface WorkerConfig {
  codexBinary: string;
  dataDirectory: string;
  name: string;
  serverUrl: string;
  token: string;
  workerId: string;
}

export function readWorkerConfig(): WorkerConfig {
  return {
    codexBinary: process.env.CANTRIP_CODEX_BIN ?? "codex",
    dataDirectory: path.resolve(
      process.cwd(),
      process.env.CANTRIP_WORKER_DATA_DIR ?? "../.cantrip/dev/worker",
    ),
    name: process.env.CANTRIP_WORKER_NAME ?? "Local Worker",
    serverUrl: (
      process.env.CANTRIP_SERVER_URL ?? "http://127.0.0.1:4310"
    ).replace(/\/$/, ""),
    token: process.env.CANTRIP_WORKER_TOKEN ?? "cantrip-local-development",
    workerId: process.env.CANTRIP_WORKER_ID ?? `local-${os.hostname()}`,
  };
}
