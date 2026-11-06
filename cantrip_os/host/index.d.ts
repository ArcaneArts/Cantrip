import type { Readable } from "node:stream";

export type GuestTransport =
  | { kind: "docker"; container: string }
  | {
      kind: "ssh";
      host: string;
      port: number;
      user: string;
      identityFile: string;
      knownHostsFile: string;
    };
export function rootGuestCommand(
  transport: GuestTransport,
  program: string,
  args: string[],
): { command: string; args: string[] };
export function packageJobSource(): Promise<string>;
export class PackageCarrierError extends Error {
  readonly delivery: "unknown";
}
export function packageControl<T = unknown>(
  transport: GuestTransport,
  args: string[],
  options?: { input?: Readable; signal?: AbortSignal },
): Promise<T>;

export class DockerDeliveryError extends Error {
  readonly delivery: "unknown";
}
export interface RetainedContainerObservation {
  containerId: string;
  name: string;
  running: boolean;
  status: string;
  startedAt: string;
  finishedAt: string;
}
export interface RetainedContainerRequest {
  operationId: string;
  action: "start" | "stop" | "restart";
  container: string;
  expectedContainerId: string;
}
export interface RetainedContainerInput extends RetainedContainerRequest {
  journalPath: string;
  signal?: AbortSignal;
}
export interface RetainedContainerOperation {
  version: 1;
  request: RetainedContainerRequest;
  state: "running" | "ready" | "failed" | "unknown";
  phase:
    "reserved" | "mutation-requested" | "mutation-acknowledged" | "verified";
  startedAt: string;
  updatedAt: string;
  before: RetainedContainerObservation | null;
  after: RetainedContainerObservation | null;
  completionEvidence: "acknowledged-and-observed" | "observed-state" | null;
  error: string | null;
}
export interface RetainedContainerResult {
  operation: RetainedContainerOperation;
  observation: RetainedContainerObservation | null;
  observationError: string | null;
}
export function changeRetainedContainer(
  engine: LocalDocker,
  input: RetainedContainerInput,
): Promise<RetainedContainerResult>;
export function observeRetainedContainer(
  engine: LocalDocker,
  input: RetainedContainerInput,
): Promise<RetainedContainerResult | null>;
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
