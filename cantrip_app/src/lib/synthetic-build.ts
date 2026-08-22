import type { DesktopUpdateActiveWorkSummary } from "@cantrip/protocol";
import { invoke, isTauri } from "@tauri-apps/api/core";

export const SYNTHETIC_BUILD_STATE_EVENT = "cantrip-synthetic-build-state";
export const SYNTHETIC_BUILD_LOG_EVENT = "cantrip-synthetic-build-log-batch";

export type SyntheticBuildPlatform = "darwin-arm64" | "win32-x64";

export interface SyntheticBuildCapability {
  available: boolean;
  platform: SyntheticBuildPlatform | null;
  reason: string | null;
}

export interface SyntheticCommit {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authoredAt: string;
  commitCount: number | null;
  syntheticVersion: string | null;
  buildable: boolean | null;
  reason: string | null;
}

export interface SyntheticCommitPage {
  commits: SyntheticCommit[];
  nextCursor: string | null;
}

export type SyntheticPrerequisiteStatus =
  "ready" | "missing" | "needsAttention";

export interface SyntheticPrerequisite {
  id: string;
  label: string;
  status: SyntheticPrerequisiteStatus;
  detectedVersion: string | null;
  requiredVersion: string;
  installation: "managed" | "system" | "guided";
  installUrl: string | null;
  message: string | null;
}

export interface SyntheticPrerequisiteScan {
  targetSha: string;
  ready: boolean;
  packageManager: string | null;
  prerequisites: SyntheticPrerequisite[];
}

export type SyntheticBuildJobState =
  "queued" | "running" | "ready-to-install" | "failed" | "cancelled";

export type SyntheticBuildStepState =
  "pending" | "running" | "complete" | "failed" | "cancelled";

export interface SyntheticBuildStep {
  id: string;
  label: string;
  state: SyntheticBuildStepState;
  weight: number;
  message: string | null;
}

export interface SyntheticBuildJobError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface SyntheticBuildJob {
  id: string;
  targetSha: string;
  version: string;
  platform: SyntheticBuildPlatform;
  state: SyntheticBuildJobState;
  stepId: string | null;
  progress: number;
  steps: SyntheticBuildStep[];
  startedAt: string;
  updatedAt: string;
  artifactPath: string | null;
  overlayDigest: string;
  lastLogSequence: number;
  error: SyntheticBuildJobError | null;
}

export interface SyntheticBuildStatus {
  job: SyntheticBuildJob | null;
}

export interface SyntheticBuildLogEntry {
  sequence: number;
  timestamp: string;
  stream: "stdout" | "stderr";
  message: string;
}

export interface SyntheticBuildLogBatch {
  entries: SyntheticBuildLogEntry[];
  nextSequence: number;
  hasMore: boolean;
}

export interface CachedSyntheticBuild {
  id: string;
  version: string;
  commitSha: string;
  buildId: string;
  builtAt: string;
  platform: SyntheticBuildPlatform;
  overlayDigest: string;
  sizeBytes: number;
  artifactPath: string;
}

export interface SyntheticBuildIdentity {
  installId: string;
  version: string;
  commitSha: string;
  buildId: string;
  builtAt: string;
  overlayDigest: string;
  installedAt: string;
}

export interface SyntheticBuildErrorShape {
  code: string;
  message: string;
  retryable: boolean;
}

export interface SyntheticBuildClient {
  capability(): Promise<SyntheticBuildCapability>;
  isSupportedEnvironment(): boolean;
  listCommits(cursor?: string): Promise<SyntheticCommitPage>;
  resolveTarget(sha: string): Promise<SyntheticCommit>;
  scanPrerequisites(sha: string): Promise<SyntheticPrerequisiteScan>;
  installPrerequisites(
    sha: string,
    ids: string[],
  ): Promise<SyntheticPrerequisiteScan>;
  start(sha: string): Promise<SyntheticBuildJob>;
  status(): Promise<SyntheticBuildStatus>;
  cancel(jobId: string): Promise<boolean>;
  logs(afterSequence?: number, limit?: number): Promise<SyntheticBuildLogBatch>;
  cached(): Promise<CachedSyntheticBuild[]>;
  install(
    artifactId: string,
    activeWork: DesktopUpdateActiveWorkSummary,
    confirmActiveWork: boolean,
  ): Promise<string>;
  deleteCached(artifactId: string): Promise<boolean>;
  identity(): Promise<SyntheticBuildIdentity | null>;
  openLog(jobId: string): Promise<void>;
  openCache(): Promise<void>;
  cleanCache(): Promise<number>;
  listenState(listener: (job: SyntheticBuildJob) => void): Promise<() => void>;
  listenLogs(
    listener: (batch: SyntheticBuildLogBatch) => void,
  ): Promise<() => void>;
}

function messageFromUnknown(error: unknown): string | null {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error instanceof Error && error.message.trim()) return error.message;
  if (!error || typeof error !== "object") return null;
  const message = Reflect.get(error, "message");
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

export function normalizeSyntheticBuildError(
  error: unknown,
  fallback = "The synthetic build operation could not be completed.",
): SyntheticBuildErrorShape {
  const record = error && typeof error === "object" ? error : null;
  const code = record ? Reflect.get(record, "code") : null;
  const retryable = record ? Reflect.get(record, "retryable") : null;
  return {
    code:
      typeof code === "string" && code.trim() ? code : "synthetic_build_failed",
    message: messageFromUnknown(error) ?? fallback,
    retryable: typeof retryable === "boolean" ? retryable : true,
  };
}

export const syntheticBuildClient: SyntheticBuildClient = {
  isSupportedEnvironment: isTauri,
  capability: () => invoke("synthetic_build_capability"),
  listCommits: (cursor) => invoke("list_synthetic_build_commits", { cursor }),
  resolveTarget: (sha) => invoke("resolve_synthetic_build_target", { sha }),
  scanPrerequisites: (sha) =>
    invoke("scan_synthetic_build_prerequisites", { sha }),
  installPrerequisites: (sha, ids) =>
    invoke("install_synthetic_build_prerequisites", { sha, ids }),
  start: (sha) => invoke("start_synthetic_build", { sha }),
  status: () => invoke("synthetic_build_status"),
  cancel: (jobId) => invoke("cancel_synthetic_build", { jobId }),
  logs: (afterSequence, limit) =>
    invoke("synthetic_build_logs", { afterSequence, limit }),
  cached: () => invoke("list_cached_synthetic_builds"),
  install: (artifactId, activeWork, confirmActiveWork) =>
    invoke("install_cached_synthetic_build", {
      artifactId,
      request: { activeWork, confirmActiveWork },
    }),
  deleteCached: (artifactId) =>
    invoke("delete_cached_synthetic_build", { artifactId }),
  identity: () => invoke("synthetic_build_identity"),
  openLog: (jobId) => invoke("open_synthetic_build_log", { jobId }),
  openCache: () => invoke("open_synthetic_build_cache"),
  cleanCache: () => invoke("clean_unused_synthetic_build_cache"),
  async listenState(listener) {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<SyntheticBuildJob>(
      SYNTHETIC_BUILD_STATE_EVENT,
      ({ payload }) => listener(payload),
    );
  },
  async listenLogs(listener) {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<SyntheticBuildLogBatch>(
      SYNTHETIC_BUILD_LOG_EVENT,
      ({ payload }) => listener(payload),
    );
  },
};
