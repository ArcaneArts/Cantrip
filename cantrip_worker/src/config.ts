import os from "node:os";
import path from "node:path";

import {
  resolveCodexInstallation,
  type CodexInstallation,
} from "./codex/bundled-runtime.js";

export interface WorkerConfig {
  codeIdleTimeoutMs: number;
  codexBinary: string;
  codexInstallation: CodexInstallation;
  dataDirectory: string;
  name: string;
  serverUrl: string;
  token: string;
  workerId: string;
}

function positiveMilliseconds(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000) {
    throw new Error(
      "CANTRIP_CODE_IDLE_TIMEOUT_MS must be an integer of at least 1000 milliseconds.",
    );
  }
  return parsed;
}

export function readWorkerConfig(): WorkerConfig {
  const codexInstallation = resolveCodexInstallation({
    override: process.env.CANTRIP_CODEX_BIN,
  });
  return {
    codeIdleTimeoutMs: positiveMilliseconds(
      process.env.CANTRIP_CODE_IDLE_TIMEOUT_MS,
      30 * 60_000,
    ),
    codexBinary: codexInstallation.binary,
    codexInstallation,
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
