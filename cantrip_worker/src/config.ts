import os from "node:os";
import path from "node:path";

import {
  resolveCodexInstallation,
  type CodexInstallation,
} from "./codex/bundled-runtime.js";
import {
  loadOrCreateWorkerIdentity,
  loadStoredWorkerCredential,
} from "./credential-store.js";

export interface WorkerConfig {
  codeIdleTimeoutMs: number;
  codexBinary: string;
  codexInstallation: CodexInstallation;
  dataDirectory: string;
  name: string;
  serverUrl: string;
  enrollmentCode: string | null;
  replacement: { workerId: string; credential: string } | null;
  token: string;
  tokenSource: "development" | "enrollment" | "environment" | "persisted";
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

export function resolveWorkerDataDirectory(): string {
  return path.resolve(
    process.cwd(),
    process.env.CANTRIP_WORKER_DATA_DIR ?? "../.cantrip/dev/worker",
  );
}

export function readWorkerConfig(): WorkerConfig {
  const codexInstallation = resolveCodexInstallation({
    override: process.env.CANTRIP_CODEX_BIN,
  });
  const serverUrl = (
    process.env.CANTRIP_SERVER_URL ?? "http://127.0.0.1:4310"
  ).replace(/\/$/, "");
  const parsedServerUrl = new URL(serverUrl);
  if (
    !["http:", "https:"].includes(parsedServerUrl.protocol) ||
    parsedServerUrl.username ||
    parsedServerUrl.password ||
    (parsedServerUrl.pathname !== "" && parsedServerUrl.pathname !== "/") ||
    parsedServerUrl.search ||
    parsedServerUrl.hash
  ) {
    throw new Error(
      "CANTRIP_SERVER_URL must be an HTTP(S) origin without a path or credentials.",
    );
  }
  const dataDirectory = resolveWorkerDataDirectory();
  const enrollmentCode =
    process.env.CANTRIP_WORKER_ENROLLMENT_CODE?.trim() || null;
  const replacementWorkerId =
    process.env.CANTRIP_WORKER_REPLACES_ID?.trim() || null;
  const replacementCredential =
    process.env.CANTRIP_WORKER_REPLACES_CREDENTIAL?.trim() || null;
  if (Boolean(replacementWorkerId) !== Boolean(replacementCredential)) {
    throw new Error(
      "CANTRIP_WORKER_REPLACES_ID and CANTRIP_WORKER_REPLACES_CREDENTIAL must be configured together.",
    );
  }
  if ((replacementWorkerId || replacementCredential) && !enrollmentCode) {
    throw new Error("Worker replacement requires an enrollment code.");
  }
  if (
    replacementCredential &&
    !/^ctwk_[A-Za-z0-9_-]{43}$/u.test(replacementCredential)
  ) {
    throw new Error("CANTRIP_WORKER_REPLACES_CREDENTIAL is malformed.");
  }
  const environmentCredential =
    process.env.CANTRIP_WORKER_CREDENTIAL?.trim() || null;
  const legacyToken = process.env.CANTRIP_WORKER_TOKEN?.trim() || null;
  const developmentBootstrap =
    process.env.CANTRIP_WORKER_DEVELOPMENT_BOOTSTRAP === "true";
  const configuredMethods = [
    enrollmentCode,
    environmentCredential,
    legacyToken,
  ].filter(Boolean);
  if (configuredMethods.length > 1) {
    throw new Error(
      "Configure only one worker authentication method: enrollment code, worker credential, or development token.",
    );
  }
  if (enrollmentCode && !/^ctwl_[A-Za-z0-9_-]{32}$/u.test(enrollmentCode)) {
    throw new Error("CANTRIP_WORKER_ENROLLMENT_CODE is malformed.");
  }
  if (
    environmentCredential &&
    !/^ctwk_[A-Za-z0-9_-]{43}$/u.test(environmentCredential)
  ) {
    throw new Error("CANTRIP_WORKER_CREDENTIAL is malformed.");
  }
  if (environmentCredential && !process.env.CANTRIP_WORKER_ID?.trim()) {
    throw new Error(
      "CANTRIP_WORKER_ID is required with CANTRIP_WORKER_CREDENTIAL because credentials are bound to an immutable worker identity.",
    );
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
    parsedServerUrl.hostname,
  );
  if (
    (legacyToken || developmentBootstrap) &&
    (!developmentBootstrap || !loopback)
  ) {
    throw new Error(
      "The legacy worker token is restricted to explicit loopback development bootstrap.",
    );
  }
  const stored =
    environmentCredential || legacyToken
      ? null
      : loadStoredWorkerCredential(dataDirectory, serverUrl);
  const pendingEnrollmentCode = stored ? null : enrollmentCode;
  const token =
    environmentCredential ??
    legacyToken ??
    stored?.credential ??
    (developmentBootstrap ? "cantrip-local-development" : "");
  if (!token && !pendingEnrollmentCode) {
    throw new Error(
      "This worker is not enrolled. Set CANTRIP_WORKER_ENROLLMENT_CODE once, or configure CANTRIP_WORKER_CREDENTIAL with its bound CANTRIP_WORKER_ID.",
    );
  }
  const workerId =
    process.env.CANTRIP_WORKER_ID?.trim() ||
    stored?.workerId ||
    (developmentBootstrap
      ? `local-${os.hostname()}`
      : loadOrCreateWorkerIdentity(dataDirectory));
  return {
    codeIdleTimeoutMs: positiveMilliseconds(
      process.env.CANTRIP_CODE_IDLE_TIMEOUT_MS,
      30 * 60_000,
    ),
    codexBinary: codexInstallation.binary,
    codexInstallation,
    dataDirectory,
    enrollmentCode: pendingEnrollmentCode,
    name: process.env.CANTRIP_WORKER_NAME ?? "Local Worker",
    replacement:
      replacementWorkerId && replacementCredential
        ? { workerId: replacementWorkerId, credential: replacementCredential }
        : null,
    serverUrl,
    token,
    tokenSource: pendingEnrollmentCode
      ? "enrollment"
      : environmentCredential
        ? "environment"
        : legacyToken || developmentBootstrap
          ? "development"
          : "persisted",
    workerId,
  };
}
