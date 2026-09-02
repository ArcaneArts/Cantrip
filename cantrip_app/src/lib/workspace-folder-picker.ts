import type { WorkerManagementSummary } from "@cantrip/protocol";

import type { DesktopWorkerStatus } from "@/lib/desktop-worker";

function isLoopbackHostname(hostname: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
    hostname.toLowerCase(),
  );
}

function sameServer(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    const sameHostname =
      leftUrl.hostname.toLowerCase() === rightUrl.hostname.toLowerCase() ||
      (isLoopbackHostname(leftUrl.hostname) &&
        isLoopbackHostname(rightUrl.hostname));
    return (
      leftUrl.protocol === rightUrl.protocol &&
      leftUrl.port === rightUrl.port &&
      sameHostname
    );
  } catch {
    return left.replace(/\/+$/u, "") === right.replace(/\/+$/u, "");
  }
}

export function workspaceFolderPickerWorkerIds(input: {
  connectionKind: "local" | "remote" | null;
  desktopWorkers: readonly DesktopWorkerStatus[];
  serverUrl: string;
  workerManagement: readonly Pick<
    WorkerManagementSummary,
    "internal" | "workerId"
  >[];
}): Set<string> {
  const workerIds = new Set(
    input.desktopWorkers
      .filter((worker) => sameServer(worker.serverUrl, input.serverUrl))
      .map((worker) => worker.workerId),
  );
  if (input.connectionKind === "local") {
    for (const worker of input.workerManagement) {
      if (worker.internal) workerIds.add(worker.workerId);
    }
  }
  return workerIds;
}
