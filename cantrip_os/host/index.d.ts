import type { Readable } from "node:stream";
export function registerBuiltPackage(
  file: string,
  metadata: {
    name: string;
    version: string;
    architecture: string;
  },
  options?: { directory?: string },
): Promise<{
  format: "cantrip-os-package-artifact";
  version: 1;
  file: string;
  artifact: {
    name: string;
    version: string;
    architecture: string;
    sha256: string;
    bytes: number;
  };
}>;

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
  engine: Pick<LocalDocker, "request" | "inspect">,
  input: RetainedContainerInput,
): Promise<RetainedContainerResult>;
export function observeRetainedContainer(
  engine: Pick<LocalDocker, "request" | "inspect">,
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
  readStream(
    path: string,
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<Readable>;
}

export interface SystemCheckpointRequest {
  operationId: string;
  container: string;
  expectedContainerId: string;
  instanceId: string;
  scopeKey: string;
  resumeOriginal: boolean;
}
export interface SystemCheckpointInput {
  request: SystemCheckpointRequest;
  journalPath: string;
  signal?: AbortSignal;
}
export interface SystemCheckpointSnapshot {
  format: "cantrip-os-private-system-image";
  version: 1;
  imageId: string;
  requestSha256: string;
  instanceId: string;
  sourceContainerId: string;
  sourceBaseImageId: string;
  architecture: string;
  os: "linux";
  createdAt: string;
  size: number;
  evidence: "acknowledged-and-verified" | "observed-labeled-image";
  consistency: "stopped-container-filesystem";
  containsPrivateIdentity: true;
  identityPolicy: "same-instance-only";
  runtimeHandlesRestored: false;
  mounts: Array<{
    type: string;
    source: string | null;
    destination: string;
    readOnly: boolean;
    included: false;
  }>;
  regeneratedPaths: string[];
}
export interface SystemCheckpointOperation {
  format: "cantrip-os-system-checkpoint";
  version: 1;
  request: SystemCheckpointRequest;
  requestSha256: string;
  state: "running" | "ready" | "failed" | "unknown";
  phase:
    | "reserved"
    | "stop-requested"
    | "stopped"
    | "commit-requested"
    | "captured"
    | "resume-requested"
    | "complete";
  createdAt: string;
  updatedAt: string;
  before: unknown;
  snapshot: SystemCheckpointSnapshot | null;
  resumeEvidence:
    "not-requested" | "acknowledged-and-observed" | "observed-state" | null;
  error: string | null;
  lastError: string | null;
}
export interface SystemCheckpointResult {
  operation: SystemCheckpointOperation;
  observation: unknown;
  observationError: string | null;
}
export function systemCheckpointRequest(
  input: SystemCheckpointInput,
): SystemCheckpointRequest;
export function captureSystemCheckpoint(
  engine: Pick<LocalDocker, "request" | "inspect">,
  input: SystemCheckpointInput,
): Promise<SystemCheckpointResult>;
export function observeSystemCheckpoint(
  engine: Pick<LocalDocker, "request" | "inspect">,
  input: SystemCheckpointInput,
): Promise<SystemCheckpointResult | null>;
export function continueSystemCheckpoint(
  engine: Pick<LocalDocker, "request" | "inspect">,
  input: SystemCheckpointInput,
): Promise<SystemCheckpointResult>;
export function openSystemCheckpointImage(
  engine: LocalDocker,
  input: SystemCheckpointInput,
): Promise<Readable>;

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
