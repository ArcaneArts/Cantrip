import type { CodeGraphProjectStatus } from "@cantrip/protocol";

function codeGraphStatusActive(
  status: CodeGraphProjectStatus | undefined,
): boolean {
  return (
    status?.state === "indexing" ||
    status?.state === "queued" ||
    status?.state === "syncing" ||
    status?.job?.state === "queued" ||
    status?.job?.state === "running"
  );
}

export function codeGraphChatRefreshIntervalMs(
  status: CodeGraphProjectStatus | undefined,
  resourcesLive: boolean,
  probeActive: boolean,
): number | false {
  if (resourcesLive) return false;
  return codeGraphStatusActive(status) || probeActive ? 500 : false;
}

export function codeGraphSettingsRefreshIntervalMs(
  status: CodeGraphProjectStatus | undefined,
  resourcesLive: boolean,
): number | false {
  if (resourcesLive) return false;
  return codeGraphStatusActive(status) ? 1_500 : 15_000;
}
