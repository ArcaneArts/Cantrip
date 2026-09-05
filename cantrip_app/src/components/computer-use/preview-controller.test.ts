import { describe, expect, it, vi } from "vitest";
import type {
  ComputerUseAction,
  ComputerUseResultContent,
  CuaAgentSource,
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
const agentSessionFixture = (): CuaSession => {
  const session = sessionFixture();
  return {
    ...session,
    binding: { ...session.binding, threadId: "child-thread", turnId: "turn" },
  };
};
const agentSourceFixture = (): CuaAgentSource => ({
  sourceId: "00000000-0000-4000-8000-000000000002",
  rootThreadId: "root-thread",
  binding: {
    ...agentSessionFixture().binding,
    threadId: "child-thread",
    turnId: "turn",
  },
  target: previewTarget,
  cursorRevision: 1,
  observationRevision: 1,
  observedAtMs: 1000,
});
function agentResult(source = agentSourceFixture()) {
  const session = { ...agentSessionFixture(), binding: source.binding };
  const image = {
    mediaType: "image/png" as const,
    width: 320,
    height: 180,
    byteCount: 3,
    sha256: "a".repeat(64),
    cursorIncluded: true as const,
  };
  return {
    content: {
      status: "ok",
      operation: "agent.observation.get",
      data: {
        source,
        session,
        image,
        nativeImage: { ...image, width: 640, height: 360 },
      },
      chunkCount: 1,
    } as ComputerUseResultContent,
    bytes: new Uint8Array([1, 2, 3]),
  };
}
function fixture(inventoryTruncated?: boolean) {
  let session = sessionFixture();
  const buffers: Uint8Array[] = [];
  const operation = vi.fn(
    async (_lease: typeof lease, action: ComputerUseAction) => {
      let data: object;
      let bytes: Uint8Array | null = null;
      switch (action.operation) {
        case "agent.sources.list":
          data = { sources: [agentSourceFixture()] };
          break;
        case "agent.observation.get": {
          const result = agentResult();
          buffers.push(result.bytes);
          return result;
        }
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
          data = { targets: [previewTarget], truncated: inventoryTruncated };
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
  it.each([
    "target-not-found",
    "stale-target",
    "permission-denied",
    "capture-failed",
  ])(
    "clears stale pixels after actual %s without creating or retrying a session",
    async (code) => {
      const { controller, operation, images, client } = fixture();
      await controller.connect();
      await controller.selectTarget(previewTarget);
      const session = controller.getSnapshot().session;
      const before = operation.mock.calls.length;
      operation.mockResolvedValueOnce({
        content: {
          status: "error",
          operation: "observation.snapshot",
          code,
          message: "Native capture failed.",
        } as ComputerUseResultContent,
        bytes: null,
      });
      await controller.snapshot();
      expect(controller.getSnapshot().observation).toBeNull();
      expect(controller.getSnapshot().session).toEqual(session);
      expect(controller.getSnapshot().error?.code).toBe(code);
      expect(images.revoke).toHaveBeenCalledWith("blob:fixture-1");
      expect(operation).toHaveBeenCalledTimes(before + 1);
      expect(client.open).toHaveBeenCalledOnce();
      expect(client.stop).not.toHaveBeenCalled();
    },
  );
  it.each(["transport", "schema", "image"])(
    "clears stale pixels on a thrown %s snapshot failure without replay",
    async (failure) => {
      const { controller, operation, images } = fixture();
      await controller.connect();
      await controller.selectTarget(previewTarget);
      const before = operation.mock.calls.length;
      const bytes = new Uint8Array([1, 2, 3]);
      if (failure === "transport") {
        operation.mockRejectedValueOnce(new Error("Connection interrupted."));
      } else if (failure === "schema") {
        operation.mockResolvedValueOnce({
          content: {
            status: "ok",
            operation: "observation.snapshot",
            data: {},
            chunkCount: 1,
          } as ComputerUseResultContent,
          bytes,
        });
      } else {
        images.create.mockImplementationOnce(() => {
          throw new Error("Image creation failed.");
        });
      }
      await controller.snapshot();
      expect(controller.getSnapshot().observation).toBeNull();
      expect(controller.getSnapshot().error?.code).toBe("request-failed");
      expect(images.revoke).toHaveBeenCalledWith("blob:fixture-1");
      expect(operation).toHaveBeenCalledTimes(before + 1);
      if (failure === "schema") expect(bytes).toEqual(new Uint8Array(3));
    },
  );
  it.each([true, false, undefined])(
    "preserves bounded inventory disclosure (%s) and clears it on Stop",
    async (truncated) => {
      const { controller } = fixture(truncated);
      await controller.connect();
      expect(controller.getSnapshot().targetsTruncated).toBe(
        truncated ?? false,
      );
      expect(controller.getSnapshot().targets).toEqual([previewTarget]);
      await controller.stop();
      expect(controller.getSnapshot().targetsTruncated).toBe(false);
    },
  );
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

describe("following completed agent observations", () => {
  async function follow() {
    const result = fixture();
    result.controller.setMode("agent");
    await result.controller.connect();
    await result.controller.selectSource(agentSourceFixture().sourceId);
    return result;
  }
  it("reads existing agent images and attribution without native/manual mutations or a second cursor", async () => {
    const { controller, operation, buffers } = await follow();
    expect(operation.mock.calls.map((call) => call[1].operation)).toEqual([
      "agent.sources.list",
      "agent.observation.get",
    ]);
    const state = controller.getSnapshot();
    expect(state.agentSource).toEqual(agentSourceFixture());
    expect(state.observation?.metadata.image.width).toBe(320);
    expect(state.observation?.nativeImage?.width).toBe(640);
    expect(buffers[0]).toEqual(new Uint8Array(3));
    await controller.selectTarget(previewTarget);
    await controller.configure(sessionFixture().cursor.appearance);
    await controller.move({ x: 2, y: 3 });
    await controller.detach();
    await controller.snapshot();
    await controller.refreshTargets();
    expect(operation).toHaveBeenCalledTimes(2);
    controller.dispose();
  });
  it("clears an expired source on explicit list refresh without choosing or fetching another source", async () => {
    const { controller, operation, images } = await follow();
    operation.mockResolvedValueOnce({
      content: {
        status: "ok",
        operation: "agent.sources.list",
        data: { sources: [] },
        chunkCount: 0,
      },
      bytes: null,
    });
    await controller.refreshSources();
    expect(controller.getSnapshot()).toMatchObject({
      sources: [],
      sourceId: null,
      agentSource: null,
      session: null,
      observation: null,
    });
    expect(images.revoke).toHaveBeenCalledWith("blob:fixture-1");
    expect(operation).toHaveBeenCalledTimes(3);
    controller.dispose();
  });
  it.each(["mode", "source", "stop", "encryption", "dispose"] as const)(
    "discards late image bytes after %s invalidates a pending read",
    async (change) => {
      const { controller, operation, client, images } = await follow();
      const pending =
        deferred<Awaited<ReturnType<ComputerUseClient["operation"]>>>();
      operation.mockImplementationOnce(() => pending.promise);
      const work = controller.refreshObservation();
      if (change === "mode") controller.setMode("manual");
      if (change === "source")
        await controller.selectSource(agentSourceFixture().sourceId);
      if (change === "stop") await controller.stop();
      if (change === "encryption") controller.encryptionUnavailable();
      if (change === "dispose") controller.dispose();
      const late = agentResult();
      pending.resolve(late);
      await work;
      expect(late.bytes).toEqual(new Uint8Array(3));
      expect(images.create).toHaveBeenCalledTimes(change === "source" ? 2 : 1);
      expect(controller.getSnapshot().observation).toEqual(
        change === "source"
          ? expect.objectContaining({ url: "blob:fixture-2" })
          : null,
      );
      expect(client.stop).toHaveBeenCalledTimes(change === "stop" ? 1 : 0);
      controller.dispose();
    },
  );
  it("clears the current rendition on a missing-source error and permits explicit recovery", async () => {
    const { controller, operation, images } = await follow();
    operation.mockResolvedValueOnce({
      content: {
        status: "error",
        operation: "agent.observation.get",
        code: "target-not-found",
        message: "Source expired.",
        outcome: "rejected",
      },
      bytes: null,
    });
    await controller.refreshObservation();
    expect(controller.getSnapshot()).toMatchObject({
      observation: null,
      session: null,
      agentSource: null,
      error: { code: "target-not-found" },
    });
    expect(images.revoke).toHaveBeenCalledWith("blob:fixture-1");
    await controller.refreshSources();
    await controller.selectSource(agentSourceFixture().sourceId);
    expect(controller.getSnapshot().observation).not.toBeNull();
    controller.dispose();
  });
  it("keeps a newly selected child source when the previous source returns late", async () => {
    const { controller, operation } = await follow();
    const first = agentSourceFixture();
    const second = {
      ...first,
      sourceId: "00000000-0000-4000-8000-000000000003",
      binding: { ...first.binding, threadId: "second-child" },
    };
    operation.mockResolvedValueOnce({
      content: {
        status: "ok",
        operation: "agent.sources.list",
        data: { sources: [first, second] },
        chunkCount: 0,
      },
      bytes: null,
    });
    await controller.refreshSources();
    const pending =
      deferred<Awaited<ReturnType<ComputerUseClient["operation"]>>>();
    operation.mockImplementationOnce(() => pending.promise);
    const oldRead = controller.refreshObservation();
    operation.mockResolvedValueOnce(agentResult(second));
    await controller.selectSource(second.sourceId);
    const late = agentResult(first);
    pending.resolve(late);
    await oldRead;
    expect(late.bytes).toEqual(new Uint8Array(3));
    expect(controller.getSnapshot().agentSource).toEqual(second);
    expect(controller.getSnapshot().session?.binding.threadId).toBe(
      "second-child",
    );
    expect(controller.getSnapshot().observation?.url).toBe("blob:fixture-2");
    controller.dispose();
  });
  it("keeps two observers independent when one changes mode or closes; explicit Stop uses the shared chat lease", async () => {
    const first = await follow();
    const second = await follow();
    first.controller.setMode("manual");
    first.controller.dispose();
    expect(first.client.stop).not.toHaveBeenCalled();
    expect(second.controller.getSnapshot().observation).not.toBeNull();
    expect(second.images.revoke).not.toHaveBeenCalled();
    await second.controller.stop();
    expect(second.client.stop).toHaveBeenCalledWith(
      lease,
      expect.any(AbortSignal),
    );
    expect(second.controller.getSnapshot().observation).toBeNull();
    second.controller.dispose();
  });
});
