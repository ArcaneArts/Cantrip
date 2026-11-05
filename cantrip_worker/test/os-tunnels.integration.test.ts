import { readFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  deriveComponentKey,
  generateAccountMasterKey,
  wrapComponentKeyForWorker,
} from "@cantrip/crypto";
import {
  decodeTunnelDataPlaneFrame,
  encodeTunnelDataPlaneFrame,
  type CantripOsExecution,
  type EncryptionPrincipal,
  type InstalledWorkerLinkGrant,
  type TunnelDataPlaneFrameHeader,
  type WorkerCommand,
  type WorkerLinkSession,
} from "@cantrip/protocol";
import {
  tunnelContentRecordSchema,
  type TunnelContentRecord,
} from "@cantrip/protocol/tunnel-content";
import {
  remoteControl,
  type OsExecutorTransport,
} from "../src/os-executor/connection.js";
import { OsServiceStream } from "../src/os-executor/service-stream.js";
import { OsTunnelServices } from "../src/os-executor/tunnel-services.js";
import { WorkerEncryptionService } from "../src/worker-encryption.js";
import { protectWorkerEndpointContent } from "../src/endpoint-content-encryption.js";
import { TunnelDestinationRouter } from "../src/tunnel-destination-router.js";
import { TunnelTcpDestinationAdapter } from "../src/tunnel-tcp-adapter.js";
import { TunnelWorkerLinkAdapter } from "../src/tunnel-worker-link-adapter.js";
import {
  sealTunnelDataFrame,
  openTunnelDataFrame,
} from "../src/tunnel-data-protection.js";
import type { ProjectShareManager } from "../src/project-share-manager.js";
import { guestTcpServer } from "./fixtures/os-tcp-server.js";

const transport: OsExecutorTransport | undefined = process.env
  .CANTRIP_OS_CUA_TEST_TRANSPORT
  ? JSON.parse(readFileSync(process.env.CANTRIP_OS_CUA_TEST_TRANSPORT, "utf8"))
  : process.env.CANTRIP_OS_CUA_TEST_CONTAINER
    ? { kind: "docker", container: process.env.CANTRIP_OS_CUA_TEST_CONTAINER }
    : undefined;
const serverId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
type Descriptor = {
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
  service: { kind: "tcp"; port: number };
};

async function wait(predicate: () => boolean, milliseconds = 30_000) {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Actual tunnel state did not converge.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

describe.skipIf(!transport)(
  "actual protected OS TCP through WorkerLink",
  () => {
    it("waits for guest readiness and preserves binary replies after request EOF", async () => {
      const server = await guestTcpServer(transport!);
      try {
        const descriptor = await remoteControl<Descriptor>(transport!, [
          "service-info",
          "cua-a",
          "--service",
          JSON.stringify({ kind: "tcp", port: server.port }),
        ]);
        const stream = await new OsServiceStream(
          transport!,
          "cua-a",
          descriptor,
        ).ready();
        const closed = once(stream, "close");
        const output: Buffer[] = [];
        stream.on("data", (data) => output.push(Buffer.from(data)));
        const payload = randomBytes(1024 * 1024 + 37);
        stream.end(payload);
        await closed;
        expect(Buffer.concat(output)).toEqual(
          Buffer.concat([
            Buffer.from(payload).reverse(),
            createHash("sha256").update(payload).digest(),
          ]),
        );
      } finally {
        await server.close();
      }
    }, 90_000);

    it("encrypts real guest traffic, rejects Host substitution and retires unopened preparations", async () => {
      const server = await guestTcpServer(transport!);
      const directory = await mkdtemp(
        path.join(tmpdir(), "cantrip-os-tunnel-"),
      );
      let services: OsTunnelServices | undefined;
      let channel:
        Awaited<ReturnType<TunnelWorkerLinkAdapter["open"]>> | undefined;
      try {
        const descriptor = await remoteControl<Descriptor>(transport!, [
          "service-info",
          "cua-a",
          "--service",
          JSON.stringify({ kind: "tcp", port: server.port }),
        ]);
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
          guestWorkspaceId: "cua-a",
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
          source: { kind: "desktop-loopback" },
          destination: {
            kind: "worker-os-tcp",
            workerId: descriptor.worker_id,
            port: server.port,
            source,
          },
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
        expect(JSON.stringify(record)).not.toContain('"port"');
        services = new OsTunnelServices(worker, descriptor.worker_id);
        const prepared: Extract<
          WorkerCommand,
          { type: "surface.tunnel.os-prepare" }
        > = {
          type: "surface.tunnel.os-prepare",
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
        const observed = await services.prepare(prepared);
        expect(observed.identity).toMatch(/^[a-f0-9]{64}$/);
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
          routePolicy: { enabled: ["local"], priority: ["local"] },
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
              "stream:guest-connect",
            ],
            maxChannels: 1,
            lease,
          },
        };
        const hostConnect = vi.fn(() => {
          throw new Error("Host TCP fallback must never run.");
        });
        const tcp = new TunnelTcpDestinationAdapter(hostConnect);
        const router = new TunnelDestinationRouter(
          tcp,
          {} as ProjectShareManager,
          worker,
          descriptor.worker_id,
          services,
        );
        const adapter = new TunnelWorkerLinkAdapter(router, services);
        const output: Buffer[] = [];
        let accepted = false,
          rejected = 0,
          credits = 0,
          inputSequence = 1,
          ended = false;
        const base = {
          protocolVersion: 1 as const,
          tunnelId,
          attachmentId,
          sourceEndpointId: `worker-link-client:${grantId}`,
          destinationEndpointId: `worker-link-worker:${descriptor.worker_id}`,
          connectionId: randomUUID(),
        };
        channel = await adapter.open({
          channel: { channelId: randomUUID(), connectionId: randomUUID() },
          grant,
          session,
          lane: "stream",
          emit: {
            close: async () => true,
            halfClose: () => true,
            error: () => true,
            data(bytes) {
              const frame = decodeTunnelDataPlaneFrame(bytes);
              if (frame.header.kind === "accepted") accepted = true;
              if (frame.header.kind === "rejected") rejected += 1;
              if (frame.header.kind === "credit") credits += frame.header.bytes;
              if (frame.header.kind === "data") {
                const plain = openTunnelDataFrame(
                  content.dataProtection,
                  frame.header,
                  frame.payload,
                );
                output.push(Buffer.from(plain));
                channel!.write?.(
                  encodeTunnelDataPlaneFrame(
                    {
                      ...base,
                      kind: "credit",
                      sequence: inputSequence++,
                      direction: "destination-to-source",
                      bytes: plain.length,
                    },
                    new Uint8Array(),
                  ),
                );
              }
              if (frame.header.kind === "half-close") ended = true;
              return true;
            },
          },
        });
        router.setFrameEmitter(
          (header, payload) => adapter.routeFrame(header, payload) ?? false,
          (attachment) =>
            adapter.waitForCapacity(attachment) ?? Promise.resolve(false),
        );
        const connect: Extract<
          TunnelDataPlaneFrameHeader,
          { kind: "connect" }
        > = {
          ...base,
          kind: "connect",
          sequence: 0,
          initialCreditBytes: 256 * 1024,
          target: {
            kind: "protected-tunnel",
            targetKind: "tcp",
            recordId: tunnelId,
            protectedRecord: record,
          },
        };
        await channel.write?.(
          encodeTunnelDataPlaneFrame(connect, new Uint8Array()),
        );
        await wait(() => accepted);
        const payload = randomBytes(1024 * 1024 + 37);
        let sent = 0;
        while (sent < payload.length) {
          const part = payload.subarray(
            sent,
            Math.min(sent + 60_000, payload.length),
          );
          const encrypted = sealTunnelDataFrame(
            content.dataProtection,
            {
              ...base,
              kind: "data",
              sequence: inputSequence++,
              direction: "source-to-destination",
            },
            part,
          );
          await channel.write?.(
            encodeTunnelDataPlaneFrame(encrypted.header, encrypted.payload),
          );
          sent += part.length;
          await wait(() => credits >= sent);
        }
        await channel.write?.(
          encodeTunnelDataPlaneFrame(
            {
              ...base,
              kind: "half-close",
              sequence: inputSequence++,
              direction: "source-to-destination",
            },
            new Uint8Array(),
          ),
        );
        await wait(() => ended);
        expect(Buffer.concat(output)).toEqual(
          Buffer.concat([
            Buffer.from(payload).reverse(),
            createHash("sha256").update(payload).digest(),
          ]),
        );
        expect(hostConnect).not.toHaveBeenCalled();
        const hostileRecord = {
          ...record,
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
            content: {
              ...content,
              destination: {
                kind: "worker-tcp",
                workerId: descriptor.worker_id,
                host: "127.0.0.1",
                port: server.port,
              },
            },
            schema: tunnelContentRecordSchema,
            service: worker,
          }),
        };
        await channel.write?.(
          encodeTunnelDataPlaneFrame(
            {
              ...connect,
              connectionId: randomUUID(),
              target: {
                kind: "protected-tunnel",
                targetKind: "tcp",
                recordId: tunnelId,
                protectedRecord: hostileRecord,
              },
            },
            new Uint8Array(),
          ),
        );
        await wait(() => rejected === 1);
        expect(hostConnect).not.toHaveBeenCalled();
        // Retiring guest state cannot turn a still-open signed guest channel
        // into a Host tunnel, including the interval before gateway teardown.
        await services.revoke(attachmentId, grantId);
        expect(() =>
          channel!.write?.(
            encodeTunnelDataPlaneFrame(
              {
                ...connect,
                connectionId: randomUUID(),
                target: {
                  kind: "protected-tunnel",
                  targetKind: "tcp",
                  recordId: tunnelId,
                  protectedRecord: hostileRecord,
                },
              },
              new Uint8Array(),
            ),
          ),
        ).toThrow(/guest tunnel was retired/);
        expect(hostConnect).not.toHaveBeenCalled();
        await channel.close?.("revoked");
        channel = undefined;
        await expect(
          services.open(attachmentId, tunnelId, record, content),
        ).rejects.toThrow(/canonical grant/);
        const unopened = {
          ...prepared,
          attachmentId: randomUUID(),
          grantId: randomUUID(),
          expectedIdentity: observed.identity,
        };
        await services.prepare(unopened);
        await adapter.revoke?.({
          grant: {
            ...grant,
            binding: {
              ...grant.binding,
              grantId: unopened.grantId,
              resource: {
                ...grant.binding.resource,
                attachmentId: unopened.attachmentId,
              },
            },
          },
          session,
        });
        expect(() =>
          services!.activate(
            {
              ...grant,
              binding: {
                ...grant.binding,
                grantId: unopened.grantId,
                resource: {
                  ...grant.binding.resource,
                  attachmentId: unopened.attachmentId,
                },
              },
            },
            session,
          ),
        ).toThrow(/preparation/);
        await expect(
          services.prepare({ ...prepared, expectedIdentity: "0".repeat(64) }),
        ).rejects.toThrow(/retired/);
      } finally {
        await channel?.close?.("revoked");
        await services?.disconnect();
        await server.close();
        await rm(directory, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
