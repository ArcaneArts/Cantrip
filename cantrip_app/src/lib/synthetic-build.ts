import { invoke, isTauri } from "@tauri-apps/api/core";

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
};
