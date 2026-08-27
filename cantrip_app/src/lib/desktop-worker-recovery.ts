import type { WorkerEnrollmentCodeResult } from "@cantrip/protocol";

import { createWorkerEnrollmentCode, unlinkWorker } from "@/lib/api";
import {
  forgetDesktopWorker,
  pairDesktopWorker,
  type DesktopWorkerCandidate,
  type DesktopWorkerStatus,
} from "@/lib/desktop-worker";

type ServerWorker = {
  online: boolean;
  sources: readonly unknown[];
  workerId: string;
};

export type AutomaticDesktopWorkerRecoveryPlan = {
  currentWorkerId: string;
  recoveryWorkerId: string;
};

export type DesktopWorkerConnectionResult = {
  desktopWorker: DesktopWorkerStatus;
  enrollment: WorkerEnrollmentCodeResult;
};

export type DesktopWorkerConnectionDependencies = {
  createEnrollment: typeof createWorkerEnrollmentCode;
  forgetDesktopWorker: typeof forgetDesktopWorker;
  pairDesktopWorker: typeof pairDesktopWorker;
  unlinkWorker: typeof unlinkWorker;
};

const defaultDependencies: DesktopWorkerConnectionDependencies = {
  createEnrollment: createWorkerEnrollmentCode,
  forgetDesktopWorker,
  pairDesktopWorker,
  unlinkWorker,
};

const activeConnections = new Map<
  string,
  Promise<DesktopWorkerConnectionResult>
>();

export function recoverableDesktopWorkerId(input: {
  candidates: Array<{ repositoryCount: number; workerId: string }>;
  linkedWorkerId: string | null;
  serverWorkerIds: string[];
}): string | null {
  if (input.linkedWorkerId) {
    const linkedWorker = input.candidates.find(
      (candidate) => candidate.workerId === input.linkedWorkerId,
    );
    if (linkedWorker && !input.serverWorkerIds.includes(input.linkedWorkerId)) {
      return linkedWorker.workerId;
    }
    if (!linkedWorker || linkedWorker.repositoryCount > 0) return null;
  }
  return (
    input.candidates.find(
      (candidate) =>
        candidate.repositoryCount > 0 &&
        candidate.workerId !== input.linkedWorkerId,
    )?.workerId ?? null
  );
}

export function automaticDesktopWorkerRecoveryPlan(input: {
  candidates: DesktopWorkerCandidate[];
  desktopWorkers: DesktopWorkerStatus[];
  serverUrl: string;
  workers: ServerWorker[];
}): AutomaticDesktopWorkerRecoveryPlan | null {
  const current = input.desktopWorkers.find(
    (worker) => worker.serverUrl === input.serverUrl,
  );
  if (!current?.running) return null;
  const serverCurrent = input.workers.find(
    (worker) => worker.workerId === current.workerId,
  );
  if (!serverCurrent?.online || serverCurrent.sources.length > 0) return null;
  const recoveryWorkerId = recoverableDesktopWorkerId({
    candidates: input.candidates,
    linkedWorkerId: current.workerId,
    serverWorkerIds: input.workers.map((worker) => worker.workerId),
  });
  if (!recoveryWorkerId) return null;
  const recoveryWorker = input.workers.find(
    (worker) => worker.workerId === recoveryWorkerId,
  );
  if (recoveryWorker?.online) return null;
  return {
    currentWorkerId: current.workerId,
    recoveryWorkerId,
  };
}

export function staleDesktopWorkerIds(input: {
  candidates: Array<{ workerId: string }>;
  selectedWorkerId: string;
  workers: ServerWorker[];
}): string[] {
  const candidates = new Set(
    input.candidates.map((candidate) => candidate.workerId),
  );
  return input.workers
    .filter(
      (worker) =>
        worker.workerId !== input.selectedWorkerId &&
        candidates.has(worker.workerId) &&
        !worker.online &&
        worker.sources.length === 0,
    )
    .map((worker) => worker.workerId);
}

async function performDesktopWorkerConnection(
  input: {
    candidates: DesktopWorkerCandidate[];
    currentWorkerId: string | null;
    recoveryWorkerId: string | null;
    serverUrl: string;
    workers: ServerWorker[];
  },
  dependencies: DesktopWorkerConnectionDependencies,
): Promise<DesktopWorkerConnectionResult> {
  const recoveryWorker = input.workers.find(
    (worker) => worker.workerId === input.recoveryWorkerId,
  );
  if (recoveryWorker?.online) {
    throw new Error(
      "The retained worker is already online and cannot be replaced.",
    );
  }
  if (recoveryWorker && input.recoveryWorkerId) {
    await dependencies.unlinkWorker(input.recoveryWorkerId);
  }
  const exactRecoveryWorkerId = input.candidates.find(
    (candidate) =>
      candidate.workerId === input.recoveryWorkerId &&
      candidate.repositoryCount > 0,
  )?.workerId;
  const enrollment = await dependencies.createEnrollment({
    label: "This machine",
    expiresInSeconds: 300,
    candidateWorkerIds: exactRecoveryWorkerId
      ? [exactRecoveryWorkerId]
      : input.candidates.map((candidate) => candidate.workerId),
  });
  if (exactRecoveryWorkerId && enrollment.workerId !== exactRecoveryWorkerId) {
    throw new Error(
      "The server did not authorize this machine's retained worker identity.",
    );
  }
  const desktopWorker = await dependencies.pairDesktopWorker({
    enrollmentCode: enrollment.code,
    name: "This machine",
    serverUrl: input.serverUrl,
    workerId: enrollment.workerId,
  });
  const staleWorkerIds = staleDesktopWorkerIds({
    candidates: input.candidates,
    selectedWorkerId: desktopWorker.workerId,
    workers: input.workers,
  });
  await Promise.allSettled(
    staleWorkerIds.map(async (workerId) => {
      await dependencies.unlinkWorker(workerId);
      await dependencies.forgetDesktopWorker(workerId);
    }),
  );
  return { desktopWorker, enrollment };
}

export async function connectDesktopWorker(
  input: {
    candidates: DesktopWorkerCandidate[];
    currentWorkerId: string | null;
    recoveryWorkerId: string | null;
    serverUrl: string;
    workers: ServerWorker[];
  },
  dependencies: DesktopWorkerConnectionDependencies = defaultDependencies,
): Promise<DesktopWorkerConnectionResult> {
  const key = `${input.serverUrl}\u0000${input.currentWorkerId ?? "new"}\u0000${input.recoveryWorkerId ?? "new"}`;
  const active = activeConnections.get(key);
  if (active) return active;
  const connection = performDesktopWorkerConnection(input, dependencies);
  activeConnections.set(key, connection);
  try {
    return await connection;
  } finally {
    if (activeConnections.get(key) === connection)
      activeConnections.delete(key);
  }
}
