import {
  desktopUpdateActiveWorkSummarySchema,
  type DesktopUpdateActiveWorkSummary,
} from "@cantrip/protocol";
import { invoke, isTauri } from "@tauri-apps/api/core";

export const DESKTOP_UPDATE_PROGRESS_EVENT = "cantrip-desktop-update-progress";

export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "ready"
  | "downloading"
  | "verifying"
  | "installing"
  | "restarting"
  | "failed";

export interface DesktopUpdateCapability {
  available: boolean;
  installedVersion: string;
  reason: string | null;
}

export interface DesktopUpdateRelease {
  currentVersion: string;
  version: string;
  publishedAt: string | null;
  releaseNotes: string | null;
}

export interface DesktopUpdateCheck {
  status: "current" | "available";
  installedVersion: string;
  release: DesktopUpdateRelease | null;
}

export interface DesktopUpdateStatus {
  phase: DesktopUpdatePhase;
  release: DesktopUpdateRelease | null;
}

export interface DesktopUpdateProgress {
  phase: DesktopUpdatePhase;
  downloadedBytes: number | null;
  totalBytes: number | null;
  message: string | null;
  restartingCurrentVersion: boolean;
}

export interface DesktopUpdateInstallRequest {
  activeWork: DesktopUpdateActiveWorkSummary;
  confirmActiveWork: boolean;
}

export interface DesktopUpdateInstallResult {
  version: string;
}

export interface DesktopUpdateErrorShape {
  code: string;
  message: string;
  retryable: boolean;
}

export interface DesktopUpdateClient {
  cancel(): Promise<boolean>;
  capability(): Promise<DesktopUpdateCapability>;
  check(): Promise<DesktopUpdateCheck>;
  getActiveWork(): Promise<DesktopUpdateActiveWorkSummary>;
  history(): Promise<DesktopUpdateRelease[]>;
  install(
    request: DesktopUpdateInstallRequest,
  ): Promise<DesktopUpdateInstallResult>;
  isSupportedEnvironment(): boolean;
  listen(
    listener: (progress: DesktopUpdateProgress) => void,
  ): Promise<() => void>;
  select(version: string): Promise<DesktopUpdateRelease>;
  status(): Promise<DesktopUpdateStatus>;
}

export type DesktopUpdateHistoryGroupLabel =
  | "Today"
  | "Yesterday"
  | "Earlier This Week"
  | "Last Week"
  | "Last Month"
  | "Older";

export interface DesktopUpdateHistoryGroup {
  label: DesktopUpdateHistoryGroupLabel;
  releases: DesktopUpdateRelease[];
}

function messageFromUnknown(error: unknown): string | null {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error instanceof Error && error.message.trim()) return error.message;
  if (!error || typeof error !== "object") return null;
  const message = Reflect.get(error, "message");
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

export function normalizeDesktopUpdateError(
  error: unknown,
  fallback = "The desktop update could not be completed.",
): DesktopUpdateErrorShape {
  const record = error && typeof error === "object" ? error : null;
  const code = record ? Reflect.get(record, "code") : null;
  const retryable = record ? Reflect.get(record, "retryable") : null;
  return {
    code:
      typeof code === "string" && code.trim() ? code : "desktop_update_failed",
    message: messageFromUnknown(error) ?? fallback,
    retryable: typeof retryable === "boolean" ? retryable : true,
  };
}

export function desktopUpdateActiveWorkTotal(
  summary: DesktopUpdateActiveWorkSummary,
): number {
  return (
    summary.activeChats +
    summary.queuedPrompts +
    summary.terminalServices +
    summary.backgroundJobs
  );
}

export function desktopUpdateActiveWorkLabels(
  summary: DesktopUpdateActiveWorkSummary,
): string[] {
  const entries: Array<[number, string, string]> = [
    [summary.activeChats, "active chat", "active chats"],
    [summary.queuedPrompts, "queued prompt", "queued prompts"],
    [summary.terminalServices, "terminal service", "terminal services"],
    [summary.backgroundJobs, "background job", "background jobs"],
  ];
  return entries.flatMap(([count, singular, plural]) =>
    count > 0
      ? [`${count.toLocaleString()} ${count === 1 ? singular : plural}`]
      : [],
  );
}

export function formatDesktopUpdateBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"] as const;
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function formatDesktopUpdateDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function daysBefore(value: Date, days: number): Date {
  const result = new Date(value);
  result.setDate(result.getDate() - days);
  return result;
}

export function groupDesktopUpdateHistory(
  releases: DesktopUpdateRelease[],
  now = new Date(),
): DesktopUpdateHistoryGroup[] {
  const today = startOfLocalDay(now);
  const yesterday = daysBefore(today, 1);
  const dayOfWeek = (today.getDay() + 6) % 7;
  const thisWeek = daysBefore(today, dayOfWeek);
  const lastWeek = daysBefore(thisWeek, 7);
  const lastMonth = daysBefore(today, 30);
  const labels: DesktopUpdateHistoryGroupLabel[] = [
    "Today",
    "Yesterday",
    "Earlier This Week",
    "Last Week",
    "Last Month",
    "Older",
  ];
  const grouped = new Map<
    DesktopUpdateHistoryGroupLabel,
    DesktopUpdateRelease[]
  >(labels.map((label) => [label, []]));

  for (const release of [...releases].sort(
    (left, right) =>
      Date.parse(right.publishedAt ?? "") - Date.parse(left.publishedAt ?? ""),
  )) {
    const publishedAt = release.publishedAt
      ? new Date(release.publishedAt)
      : null;
    const label: DesktopUpdateHistoryGroupLabel =
      !publishedAt || Number.isNaN(publishedAt.getTime())
        ? "Older"
        : publishedAt >= today
          ? "Today"
          : publishedAt >= yesterday
            ? "Yesterday"
            : publishedAt >= thisWeek
              ? "Earlier This Week"
              : publishedAt >= lastWeek
                ? "Last Week"
                : publishedAt >= lastMonth
                  ? "Last Month"
                  : "Older";
    grouped.get(label)?.push(release);
  }

  return labels.flatMap((label) => {
    const entries = grouped.get(label) ?? [];
    return entries.length > 0 ? [{ label, releases: entries }] : [];
  });
}

async function getLocalActiveWork(): Promise<DesktopUpdateActiveWorkSummary> {
  try {
    const localServerUrl = await invoke<string>("local_server_url");
    if (!localServerUrl) throw new Error("The embedded server is unavailable.");
    const endpoint = new URL(
      "/api/desktop-update/active-work",
      `${localServerUrl.replace(/\/+$/u, "")}/`,
    );
    const response = await fetch(endpoint, { credentials: "omit" });
    if (!response.ok) {
      throw new Error(`The embedded server returned HTTP ${response.status}.`);
    }
    return desktopUpdateActiveWorkSummarySchema.parse(await response.json());
  } catch (error) {
    throw {
      code: "update_active_work_unavailable",
      message:
        "Cantrip could not verify local work before updating. Make sure the local server is running, then try again.",
      retryable: true,
      cause: error,
    } satisfies DesktopUpdateErrorShape & { cause: unknown };
  }
}

export const desktopUpdateClient: DesktopUpdateClient = {
  isSupportedEnvironment: isTauri,
  capability: () => invoke("desktop_update_capability"),
  status: () => invoke("desktop_update_status"),
  check: () => invoke("check_desktop_update"),
  history: () => invoke("list_desktop_update_history"),
  select: (version) => invoke("select_desktop_update", { version }),
  install: (request) => invoke("install_desktop_update", { request }),
  cancel: () => invoke("cancel_desktop_update"),
  getActiveWork: getLocalActiveWork,
  async listen(listener) {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<DesktopUpdateProgress>(
      DESKTOP_UPDATE_PROGRESS_EVENT,
      ({ payload }) => listener(payload),
    );
  },
};
