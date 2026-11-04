export class DockerDeliveryError extends Error {
  readonly delivery: "unknown";
}
export function finalizeRecreation(
  engine: LocalDocker,
  journalPath: string,
  options?: { signal?: AbortSignal },
): Promise<void>;
export class DockerApiError extends Error {
  readonly status: number;
}
export class LocalDocker {
  constructor(socketPath: string);
  static current(): Promise<LocalDocker>;
  request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<T>;
  inspect<T = unknown>(
    container: string,
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<T>;
}

export interface LinkedSourceMount {
  id: string;
  /** Stable canonical source/worktree/workspace identity across binding revisions. */
  cacheKey?: string;
  workerPath: string;
  guestPath: string;
  dependencyOverlays: Array<{ path: string }>;
}
export function sourceMounts(
  record: unknown,
  expectedInstanceId?: string,
): LinkedSourceMount[];
export const sourceMountsLabel: string;
export function dependencyVolumes(
  instanceId: string,
  bindings: LinkedSourceMount[],
): Array<{ name: string; guestPath: string }>;
export function mountedConfiguration(
  record: unknown,
  instanceId: string,
  bindings: LinkedSourceMount[],
  options?: { image?: string },
): unknown;
export function recreateWithSources(
  engine: LocalDocker,
  input: {
    container: string;
    expectedContainerId: string;
    instanceId: string;
    bindings: LinkedSourceMount[];
    operationId: string;
    journalPath: string;
    image?: string;
    preserveSystem?: boolean;
    signal?: AbortSignal;
  },
): Promise<{
  containerId: string;
  previousContainerId: string;
  journalPath: string;
}>;
export function withInstanceLock<T>(
  name: string,
  action: () => Promise<T>,
  options?: { signal?: AbortSignal; wait?: boolean },
): Promise<T>;
