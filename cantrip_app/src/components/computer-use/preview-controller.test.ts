import { describe, expect, it, vi } from "vitest";
import type {
  ComputerUseAction,
  ComputerUseResultContent,
  CuaSession,
  CuaTarget,
} from "@cantrip/protocol/computer-use";
import type { ComputerUseClient } from "@/lib/computer-use-client";
import { ComputerUsePreviewController } from "./preview-controller";

const lease = {
  leaseId: "00000000-0000-4000-8000-000000000001",
  workerId: "worker",
  chatId: "chat",
  generation: 1,
};
export const previewTarget: CuaTarget = {
  id: "monitor",
  generation: 1,
  kind: "monitor",
  title: "Fixture monitor",
  application: null,
  processId: null,
  bounds: { x: -320, y: -90, width: 320, height: 180 },
  pixelWidth: 640,
  pixelHeight: 360,
  scaleFactor: 2,
  focused: null,
  minimized: null,
};
const sessionFixture = (): CuaSession => ({
  binding: {
    workerId: "worker",
    chatId: "chat",
    taskId: null,
    threadId: null,
    turnId: null,
    sessionId: "native-session",
  },
  target: previewTarget,
  cursor: {
    appearance: {
      version: 1,
      style: "arrow",
      color: "#0088ff",
      size: 24,
      label: null,
      trail: false,
      visible: true,
    },
    position: { x: 10, y: 10 },
    trailPoints: [],
    updatedAtMs: 1,
    revision: 1,
  },
  observationRevision: 1,
});
function fixture() {
  let session = sessionFixture();
  const buffers: Uint8Array[] = [];
  const operation = vi.fn(
    async (_lease: typeof lease, action: ComputerUseAction) => {
      let data: object;
      let bytes: Uint8Array | null = null;
      switch (action.operation) {
        case "capabilities.get":
          data = {
            protocolVersion: 1,
            runtimeVersion: "0.0.0",
            backend: "fake",
            capture: true,
            nativeInput: false,
            javascript: false,
            cursorAppearanceVersion: 1,
            operations: [],
            maxSessions: 16,
            maxImageBytes: 1024,
          };
          break;
        case "targets.list":
          data = { targets: [previewTarget] };
          break;
        case "session.open":
          session = { ...session, target: previewTarget };
          data = { session };
          break;
        case "cursor.configure":
          session = {
            ...session,
            cursor: { ...session.cursor, appearance: action.appearance },
          };
          data = { session };
          break;
        case "cursor.move":
          session = {
            ...session,
            cursor: { ...session.cursor, position: action.position },
          };
          data = { session };
          break;
        case "target.detach":
          session = { ...session, target: null };
          data = { session };
          break;
        case "observation.snapshot":
          bytes = new Uint8Array([1, 2, 3]);
          buffers.push(bytes);
          data = {
            session,
            image: {
              mediaType: "image/png",
              width: 640,
              height: 360,
              byteCount: 3,
              sha256: "a".repeat(64),
              cursorIncluded: true,
            },
          };
          break;
        default:
          data = { session };
      }
      return {
        content: {
          status: "ok",
          operation: action.operation,
          data,
          chunkCount: bytes ? 1 : 0,
        } as ComputerUseResultContent,
        bytes,
      };
    },
  );
  const client: ComputerUseClient = {
    open: vi.fn(async () => ({ ...lease })),
    operation,
    stop: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  let image = 0;
  const images = {
    create: vi.fn(() => `blob:fixture-${++image}`),
    revoke: vi.fn(),
  };
  const controller = new ComputerUsePreviewController(client, images);
  return { controller, client, operation, images, buffers };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ComputerUsePreviewController", () => {
  it("is inert until explicitly connected and then renders a target snapshot", async () => {
    const { controller, client, images, buffers } = fixture();
    expect(client.open).not.toHaveBeenCalled();
    await controller.connect();
    expect(controller.getSnapshot().capabilities?.backend).toBe("fake");
    await controller.selectTarget(previewTarget);
    expect(controller.getSnapshot().observation?.url).toBe("blob:fixture-1");
    expect(images.create).toHaveBeenCalledOnce();
    expect(buffers[0]).toEqual(new Uint8Array(3));
  });
  it.each(["arrow", "dot", "ring", "crosshair"] as const)(
    "applies %s appearance and captures the resulting cursor immediately",
    async (style) => {
      const { controller, operation, images } = fixture();
      await controller.connect();
      await controller.selectTarget(previewTarget);
      const appearance = {
        ...controller.getSnapshot().session!.cursor.appearance,
        style,
        label: "Agent",
        trail: true,
        color: "#f12345aa",
        size: 96,
      };
      await controller.configure(appearance);
      expect(
        controller.getSnapshot().observation?.metadata.session.cursor
          .appearance,
      ).toEqual(appearance);
      expect(
        operation.mock.calls.slice(-2).map((call) => call[1].operation),
      ).toEqual(["cursor.configure", "observation.snapshot"]);
      expect(images.revoke).toHaveBeenCalledWith("blob:fixture-1");
    },
  );
  it("moves target-local logical cursor without any native input operation", async () => {
    const { controller, operation } = fixture();
    await controller.connect();
    await controller.selectTarget(previewTarget);
    await controller.move({ x: 100, y: 50 });
    expect(controller.getSnapshot().session!.cursor.position).toEqual({
      x: 100,
      y: 50,
    });
    expect(
      operation.mock.calls.slice(-2).map((call) => call[1].operation),
    ).toEqual(["cursor.move", "observation.snapshot"]);
    await controller.detach();
    expect(controller.getSnapshot().observation).toBeNull();
    expect(controller.getSnapshot().session!.target).toBeNull();
  });
  it("does not automatically retry denied actions or keep an outdated image after a failed mutation", async () => {
    const { controller, operation } = fixture();
    await controller.connect();
    await controller.selectTarget(previewTarget);
    operation.mockResolvedValueOnce({
      content: {
        status: "error",
        operation: "cursor.move",
        code: "approval-required",
        message: "Approval required",
        outcome: "not-sent",
      },
      bytes: null,
    });
    const prior = operation.mock.calls.length;
    await controller.move({ x: 10, y: 20 });
    expect(operation).toHaveBeenCalledTimes(prior + 1);
    expect(controller.getSnapshot().error?.code).toBe("approval-required");
    expect(controller.getSnapshot().observation).toBeNull();
  });
  it("Stop bypasses pending work and discards a late result without restoring pixels", async () => {
    const { controller, operation, client } = fixture();
    await controller.connect();
    await controller.selectTarget(previewTarget);
    const pending =
      deferred<Awaited<ReturnType<ComputerUseClient["operation"]>>>();
    operation.mockImplementationOnce(() => pending.promise);
    const work = controller.snapshot();
    await controller.stop();
    expect(client.stop).toHaveBeenCalledWith(lease, expect.any(AbortSignal));
    const bytes = new Uint8Array([9, 9]);
    pending.resolve({
      content: {
        status: "error",
        operation: "observation.snapshot",
        code: "cancelled",
        message: "Cancelled",
        outcome: "unknown",
      },
      bytes,
    });
    await work;
    expect(bytes).toEqual(new Uint8Array(2));
    expect(controller.getSnapshot()).toMatchObject({
      phase: "stopped",
      observation: null,
      error: null,
      busy: false,
    });
  });
  it("closing an observer only releases local images and requests", async () => {
    const { controller, client, images } = fixture();
    await controller.connect();
    await controller.selectTarget(previewTarget);
    controller.dispose();
    controller.dispose();
    expect(client.stop).not.toHaveBeenCalled();
    expect(client.dispose).toHaveBeenCalledOnce();
    expect(images.revoke).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().observation).toBeNull();
  });
  it("retains the lease when Stop fails so the exact Stop can be retried", async () => {
    const { controller, client } = fixture();
    await controller.connect();
    vi.mocked(client.stop).mockRejectedValueOnce(
      new Error("Worker unavailable"),
    );
    await controller.stop();
    expect(controller.getSnapshot().lease).toEqual(lease);
    expect(controller.getSnapshot().error?.code).toBe("stop-failed");
    await controller.stop();
    expect(client.stop).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().lease).toBeNull();
    await controller.connect();
    expect(client.open).toHaveBeenCalledTimes(2);
  });
  it("clears protected display on encryption lock but keeps Stop usable", async () => {
    const { controller, client } = fixture();
    await controller.connect();
    await controller.selectTarget(previewTarget);
    controller.encryptionUnavailable();
    expect(controller.getSnapshot().observation).toBeNull();
    expect(controller.getSnapshot().session).toBeNull();
    await controller.stop();
    expect(client.stop).toHaveBeenCalledOnce();
  });
  it("does not queue more actions while an explicit request is pending", async () => {
    const { controller, operation } = fixture();
    await controller.connect();
    await controller.selectTarget(previewTarget);
    const pending =
      deferred<Awaited<ReturnType<ComputerUseClient["operation"]>>>();
    operation.mockImplementationOnce(() => pending.promise);
    const before = operation.mock.calls.length;
    const first = controller.snapshot();
    await controller.snapshot();
    await controller.move({ x: 10, y: 10 });
    expect(operation).toHaveBeenCalledTimes(before + 1);
    pending.resolve({
      content: {
        status: "error",
        operation: "observation.snapshot",
        code: "closed",
        message: "Closed",
        outcome: "rejected",
      },
      bytes: null,
    });
    await first;
  });
  it("does not continue a connect request after Stop during lease creation", async () => {
    const { controller, client, operation } = fixture();
    const pending = deferred<typeof lease>();
    vi.mocked(client.open).mockReturnValueOnce(pending.promise);
    const work = controller.connect();
    await controller.stop();
    pending.resolve(lease);
    await work;
    expect(operation).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe("stopped");
  });
});
