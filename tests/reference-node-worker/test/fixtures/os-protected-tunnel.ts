import { randomUUID, randomBytes } from "node:crypto";
import {
  deriveComponentKey,
  generateAccountMasterKey,
  wrapComponentKeyForWorker,
} from "@cantrip/crypto";
import type {
  CantripOsExecution,
  EncryptionPrincipal,
  InstalledWorkerLinkGrant,
  WorkerCommand,
  WorkerLinkSession,
} from "@cantrip/protocol";
import {
  tunnelContentRecordSchema,
  type TunnelContentRecord,
} from "@cantrip/protocol/tunnel-content";
import { WorkerEncryptionService } from "../../src/worker-encryption.js";
import { protectWorkerEndpointContent } from "../../src/endpoint-content-encryption.js";
import type { OsExecutorTransport } from "../../src/os-executor/connection.js";
export const serverId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export interface Descriptor {
  instance_id: string;
  generation: string;
  owner_id: string;
  worker_id: string;
  workspace_id: string;
  uid: number;
  gid: number;
  home: string;
  user: string;
  remote_generation: string;
  service:
    | { kind: "tcp"; port: number }
    | { kind: "listen"; port: number }
    | { kind: "ssh" }
    | { kind: "vnc" };
  display?: number;
  desktop_generation?: string;
  ssh_host_key?: string;
}
async function encryption(directory: string, descriptor: Descriptor) {
  const service = await WorkerEncryptionService.open({
    dataDirectory: directory,
    serverUrl: "https://cantrip.test",
    workerId: descriptor.worker_id,
  });
  const registration = service.registration(),
    now = new Date().toISOString();
  const principal: EncryptionPrincipal = {
    id: registration.principalId,
    ownerId: descriptor.owner_id,
    workerId: descriptor.worker_id,
    kind: "worker",
    label: "Guest tunnel fixture",
    publicKey: registration.publicKey,
    state: "approved",
    revision: 1,
    approvedAt: now,
    revokedAt: null,
    revokedReason: null,
    createdAt: now,
    updatedAt: now,
  };
  const key = deriveComponentKey({
    accountMasterKey: generateAccountMasterKey(),
    ownerId: descriptor.owner_id,
    component: "tunnel-content",
    keyRevision: 1,
  });
  await service.acceptBootstrap({
    serverId,
    ownerId: descriptor.owner_id,
    principal,
    grants: [
      {
        id: randomUUID(),
        ownerId: descriptor.owner_id,
        principalId: principal.id,
        component: "tunnel-content",
        keyRevision: 1,
        wrappedKey: await wrapComponentKeyForWorker({
          ownerId: descriptor.owner_id,
          workerId: descriptor.worker_id,
          component: "tunnel-content",
          componentKey: key,
          keyRevision: 1,
          workerPublicKey: principal.publicKey,
        }),
        state: "active",
        revision: 1,
        revokedAt: null,
        revokedReason: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
  return service;
}

export async function protectedOsTunnel(
  transport: OsExecutorTransport,
  directory: string,
  descriptor: Descriptor,
  destination:
    | { kind: "worker-os-tcp"; port: number }
    | { kind: "worker-os-ssh"; publicKey: string }
    | { kind: "worker-os-vnc" }
    | { kind: "worker-os-listener"; port: number; hostPort: number },
) {
  const worker = await encryption(directory, descriptor);
  const tunnelId = randomUUID(),
    attachmentId = randomUUID(),
    grantId = randomUUID();
  const scope: CantripOsExecution["scope"] = {
    ownerId: descriptor.owner_id,
    workerId: descriptor.worker_id,
    instanceId: randomUUID(),
    guestInstanceId: descriptor.instance_id,
    attachmentGeneration: randomUUID(),
    runtimeGeneration: descriptor.generation,
    bindingId: randomUUID(),
    bindingGeneration: randomUUID(),
    projectId: randomUUID(),
    projectSourceId: randomUUID(),
    sourceKind: "folder",
    worktreeId: randomUUID(),
    workspaceId: randomUUID(),
    guestWorkspaceId: descriptor.workspace_id,
    uid: descriptor.uid,
    gid: descriptor.gid,
    homeGuestPath: descriptor.home,
    guestPath: descriptor.home,
    dependencyOverlays: [],
    mode: "linux-owned",
    linkedWorkerPath: null,
  };
  const source = {
    bindingId: scope.bindingId,
    worktreeId: scope.worktreeId,
    bindingGeneration: scope.bindingGeneration,
    attachmentGeneration: scope.attachmentGeneration,
    runtimeGeneration: scope.runtimeGeneration,
  };
  const content: TunnelContentRecord = {
    name: "Private guest endpoint",
    description: null,
    source:
      destination.kind === "worker-os-listener"
        ? {
            kind: "worker-os-listener",
            workerId: descriptor.worker_id,
            source,
            port: destination.port,
          }
        : { kind: "desktop-loopback" },
    destination:
      destination.kind === "worker-os-listener"
        ? {
            kind: "worker-tcp",
            workerId: descriptor.worker_id,
            host: "127.0.0.1",
            port: destination.hostPort,
          }
        : { ...destination, workerId: descriptor.worker_id, source },
    dataProtection: {
      formatVersion: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      key: randomBytes(32).toString("base64url"),
    },
  };
  const record = {
    operationId: tunnelId,
    revision: 1,
    protectedContent: await protectWorkerEndpointContent({
      context: {
        domain: "tunnel-content",
        serverId,
        workerId: descriptor.worker_id,
        scopeId: JSON.stringify(["tunnel", tunnelId]),
        operationId: tunnelId,
        operation: "tunnel.record",
        direction: "stored",
        sequence: 1,
      },
      content,
      schema: tunnelContentRecordSchema,
      service: worker,
    }),
  };
  const prepared: Extract<
    WorkerCommand,
    { type: "surface.tunnel.os-prepare" }
  > = {
    type: "surface.tunnel.os-prepare",
    ...(destination.kind === "worker-os-listener"
      ? { mode: "listen" as const }
      : {}),
    serverId,
    projectId: scope.projectId,
    tunnelId,
    attachmentId,
    grantId,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    expectedIdentity: null,
    protectedRecord: record,
    osExecution: { kind: "cantrip-os", scope, transport: transport! },
  };
  const now = new Date().toISOString();
  const identity = {
    serverId,
    serverGeneration: "fixture-server-generation",
    ownerId: descriptor.owner_id,
    accountSessionId: "fixture-account",
    clientInstanceId: "fixture-client",
    workerId: descriptor.worker_id,
    workerProcessGeneration: "fixture-worker-generation",
  };
  const lease = {
    issuedAt: now,
    expiresAt: prepared.expiresAt,
    absoluteExpiresAt: prepared.expiresAt,
  };
  const session: WorkerLinkSession = {
    sessionId: randomUUID(),
    identity,
    lease,
    routePolicy: {
      enabled: ["local"],
      priority: ["local", "lan", "wan", "relay"],
    },
    routeGeneration: 1,
    preferredRoute: "local",
  };
  const grant: InstalledWorkerLinkGrant = {
    tokenHash: "a".repeat(64),
    binding: {
      grantId,
      grantGeneration: 1,
      sessionId: session.sessionId,
      identity,
      resource: { kind: "tunnel", resourceId: tunnelId, attachmentId },
      lanes: ["stream"],
      operations: [
        "stream:open",
        "stream:read",
        "stream:write",
        "stream:half-close",
        destination.kind === "worker-os-listener"
          ? "stream:guest-listen"
          : "stream:guest-connect",
      ],
      maxChannels: 1,
      lease,
    },
  };
  return {
    worker,
    scope,
    source,
    tunnelId,
    attachmentId,
    grantId,
    content,
    record,
    prepared,
    session,
    grant,
  };
}
