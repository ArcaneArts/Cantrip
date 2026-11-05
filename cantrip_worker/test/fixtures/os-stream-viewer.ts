import { randomUUID } from "node:crypto";
import { encryptSurfacePrivateState } from "@cantrip/crypto";
import { cantripOsExecutionSchema } from "@cantrip/protocol";
import { OsDesktopSession } from "../../src/desktop/os-desktop.js";
import { OsCuaServices } from "../../src/os-executor/computer-use.js";
import { CantripCuaService } from "../../src/computer-use/service.js";
import {
  remoteControl,
  type OsExecutorTransport,
} from "../../src/os-executor/connection.js";
import type { WorkerEncryptionService } from "../../src/worker-encryption.js";
export interface StreamDesktop {
  instance_id: string;
  generation: string;
  owner_id: string;
  worker_id: string;
  workspace_id: string;
  desktop_generation: string;
  remote_generation: string;
  uid: number;
  gid: number;
  home: string;
  display: number;
}
/** Real Worker production surface and native service; fixture keys never leave Worker. */
export async function streamViewer(
  transport: OsExecutorTransport,
  frame: (bytes: number) => void,
) {
  const desktop = await remoteControl<StreamDesktop>(transport, [
    "open",
    "cua-a",
  ]);
  const scope = {
    ownerId: desktop.owner_id,
    workerId: desktop.worker_id,
    projectId: "os-stream-measurement",
    instanceId: randomUUID(),
    guestInstanceId: desktop.instance_id,
    attachmentGeneration: randomUUID(),
    runtimeGeneration: desktop.generation,
    bindingId: randomUUID(),
    bindingGeneration: randomUUID(),
    projectSourceId: randomUUID(),
    worktreeId: randomUUID(),
    workspaceId: randomUUID(),
    guestWorkspaceId: desktop.workspace_id,
    uid: desktop.uid,
    gid: desktop.gid,
    homeGuestPath: desktop.home,
    guestPath: desktop.home + "/Documents",
    sourceKind: "folder",
    mode: "linux-owned",
    linkedWorkerPath: null,
    dependencyOverlays: [],
  };
  const execution = cantripOsExecutionSchema.parse({
    kind: "cantrip-os",
    transport,
    scope,
  });
  const host = new CantripCuaService({
    workerId: desktop.worker_id,
    launch: () => {
      throw new Error("Benchmark must never use the Host desktop.");
    },
  });
  const services = new OsCuaServices({
    workerId: desktop.worker_id,
    host,
    placements: { resolve: () => execution },
  });
  const serverId = "os-stream-measurement",
    surfaceId = randomUUID(),
    key = new Uint8Array(32).fill(73);
  const encryption = {
    ownerId: () => desktop.owner_id,
    status: () => ({ error: null }),
    componentKey: () => ({ key: key.slice(), keyRevision: 1 }),
  } as unknown as WorkerEncryptionService;
  const stateProtection = await encryptSurfacePrivateState({
    ownerId: desktop.owner_id,
    context: {
      serverId,
      resource: "remote-desktop-row",
      resourceId: surfaceId,
      operationId: null,
      recordKind: "remote-desktop-state",
    },
    keyRevision: 1,
    componentKey: key,
    content: {
      version: 1,
      classification: { recordKind: "remote-desktop-state" },
      revision: 1,
      target: { kind: "monitor", id: null, name: null },
    },
  });
  let viewer: OsDesktopSession | undefined;
  const lifetime = new AbortController();
  const lease = await services.acquireExecution(
    serverId,
    execution,
    lifetime.signal,
    desktop.desktop_generation,
  );
  const inputScope = {
    serverId,
    ownerId: desktop.owner_id,
    workerId: desktop.worker_id,
    chatId: randomUUID(),
    taskId: null,
    threadId: "stream-thread",
    turnId: "stream-turn",
  };
  const target = (await lease.service.targets(inputScope))[0]!;
  const reference = {
    targetId: target.id,
    targetGeneration: target.generation,
  };
  const session = await lease.service.open(inputScope, reference);
  return {
    desktop,
    async open() {
      viewer = new OsDesktopSession(
        {
          type: "surface.attach",
          surfaceId,
          attachmentId: "measured-viewer",
          serverId,
          projectId: scope.projectId,
          configuration: {
            kind: "desktop",
            osSource: {
              bindingId: scope.bindingId,
              worktreeId: scope.worktreeId,
              bindingGeneration: scope.bindingGeneration,
              attachmentGeneration: scope.attachmentGeneration,
              runtimeGeneration: scope.runtimeGeneration,
              desktopGeneration: desktop.desktop_generation,
            },
          },
          osExecution: execution,
          stateProtection,
          stateRevision: 1,
          stateResource: "remote-desktop-row",
          preferredTransport: "websocket",
          webrtc: null,
          viewport: { width: 1440, height: 900, devicePixelRatio: 1 },
          desktopStream: { targetFps: 15, quality: "adaptive" },
        },
        (_id, channel, payload) => {
          if (channel === "frame") {
            if (payload[0] !== 255 || payload[1] !== 216)
              throw new Error("Production surface did not emit JPEG.");
            frame(payload.byteLength);
          }
          return true;
        },
        services,
        encryption,
        desktop.worker_id,
      );
      await viewer.attach({
        id: "measured-viewer",
        viewport: { width: 1440, height: 900, devicePixelRatio: 1 },
      });
    },
    async disconnect() {
      await viewer?.close();
      viewer = undefined;
    },
    key: () =>
      lease.service.perform(inputScope, session.binding.sessionId, reference, {
        kind: "key",
        key: "Escape",
        modifiers: [],
      }),
    clipboard: (text: string) =>
      lease.service.writeClipboard(
        inputScope,
        session.binding.sessionId,
        reference,
        text,
      ),
    async close() {
      await viewer?.close();
      await lease.release();
      await services.close();
    },
  };
}
