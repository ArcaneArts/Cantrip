import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkerInputParticipants,
  type InteractionBinding,
  type InteractionEvent,
} from "./participants.js";
import { CantripCuaService } from "./service.js";
import { CUA_REQUIRED_OPERATIONS } from "./types.js";
import { CuaNativeError, CuaProcessError } from "./errors.js";
import type { CuaTransport, CuaTransportOptions } from "./transport.js";
const target = {
  id: "fake-window",
  generation: 1,
  kind: "window",
  title: null,
  application: null,
  processId: 12,
  bounds: { x: 0, y: 0, width: 100, height: 100 },
  pixelWidth: 100,
  pixelHeight: 100,
  scaleFactor: 1,
  focused: false,
  minimized: false,
};
const cursor = {
  appearance: {
    version: 1,
    style: "arrow",
    color: "#20BFA9",
    size: 24,
    label: null,
    trail: false,
    visible: true,
  },
  position: { x: 0, y: 0 },
  trailPoints: [],
  updatedAtMs: 0,
  revision: 1,
};
const targetRef = { targetId: target.id, targetGeneration: 1 };
const binding = (id: string): InteractionBinding => ({
  workerId: "worker",
  surfaceId: "surface",
  attachmentId: id,
  participantId: id,
});
const key: InteractionEvent = {
  type: "keyDown",
  data: { key: "K", modifiers: ["Meta"], repeat: false },
};
const response = (data: unknown) => ({ data, payload: Buffer.alloc(0) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closes.splice(0).map((close) => close()));
});
function fixture() {
  let handle = 0;
  const request = vi.fn<CuaTransport["request"]>(async (operation: any) => {
    const q = operation.request;
    if (operation.operation === "capabilities.get")
      return response({
        protocolVersion: 1,
        runtimeVersion: "fixture",
        backend: "fake",
        capture: true,
        nativeInput: true,
        javascript: false,
        cursorAppearanceVersion: 1,
        operations: [...CUA_REQUIRED_OPERATIONS],
        maxSessions: 16,
        maxImageBytes: 16 * 1024 * 1024,
      });
    if (q.type === "open")
      return response({ handle: ++handle, target, cursor });
    if (q.type === "input")
      return response({
        handle: q.handle,
        sequence: q.sequence,
        outcome: "dispatched",
        windowDelivery: "unverified",
        cursor,
      });
    return response({ closed: true });
  });
  const runtime = {
    transport: {
      request,
      closed: false,
      close: vi.fn(async () => {
        runtime.transport.closed = true;
      }),
    },
  };
  let current = runtime;
  const participants = new WorkerInputParticipants({
    runtime: async () => current,
    isCurrent: (r) => r === current,
    authorize: () => {},
    background: (work) => {
      void work.catch(() => {});
    },
  });
  closes.push(() => participants.closeAll());
  return {
    participants,
    runtime,
    request,
    replace: () => {
      current = {
        ...runtime,
        transport: {
          ...runtime.transport,
          request: vi.fn((...args: Parameters<CuaTransport["request"]>) =>
            runtime.transport.request(...args),
          ),
        },
      };
      return current;
    },
  };
}
describe("worker input participants", () => {
  it("preserves independent holds and original sequences; cleanup is attachment scoped", async () => {
    const { participants, request } = fixture();
    const a = await participants.open(binding("a"), targetRef);
    const b = await participants.open(binding("b"), targetRef);
    await a.send(4, key);
    await b.send(1, key);
    await expect(a.send(4, key)).rejects.toMatchObject({ outcome: "not-sent" });
    await a.close();
    await expect(a.send(5, key)).rejects.toMatchObject({ outcome: "not-sent" });
    await b.send(2, { type: "keyUp", data: { key: "K" } });
    const operations = request.mock.calls.map(([o]) => (o as any).request);
    expect(
      operations
        .filter((o) => o.type === "input")
        .map((o) => [o.binding.attachmentId, o.sequence, o.event.type]),
    ).toEqual([
      ["a", 4, "keyDown"],
      ["b", 1, "keyDown"],
      ["b", 2, "keyUp"],
    ]);
    expect(
      operations
        .filter((o) => o.type === "closeBinding")
        .map((o) => o.binding.attachmentId),
    ).toEqual(["a"]);
  });
  it("does not replay uncertain input, or send queued actions after failure", async () => {
    const { participants, request } = fixture();
    const a = await participants.open(binding("a"), targetRef);
    const pending = deferred<Awaited<ReturnType<CuaTransport["request"]>>>();
    request.mockImplementationOnce(() => pending.promise);
    const first = a.send(1, key);
    const second = a.send(2, key);
    const failures = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    pending.reject(new CuaNativeError("input-unknown"));
    expect((await failures).every((r) => r.status === "rejected")).toBe(true);
    expect(
      request.mock.calls.filter(([o]) => (o as any).request.type === "input"),
    ).toHaveLength(1);
    expect(
      request.mock.calls.filter(
        ([o]) => (o as any).request.type === "closeBinding",
      ),
    ).toHaveLength(1);
  });
  it("cancels an opening attachment and releases a late native open", async () => {
    const { participants, request } = fixture();
    const pending = deferred<Awaited<ReturnType<CuaTransport["request"]>>>();
    request.mockImplementationOnce(() => pending.promise);
    const signal = new AbortController();
    const opened = participants.open(binding("a"), targetRef, signal.signal);
    const result = Promise.allSettled([opened]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    signal.abort();
    pending.resolve(response({ handle: 1, target, cursor }));
    expect((await result)[0].status).toBe("rejected");
    expect((request.mock.calls[1]![0] as any).request).toEqual({
      type: "closeBinding",
      binding: binding("a"),
    });
  });
  it("never uses a replacement helper for old input or cleanup", async () => {
    const { participants, runtime, request, replace } = fixture();
    const a = await participants.open(binding("a"), targetRef);
    const replacement = replace();
    participants.runtimeFailed(runtime);
    await expect(a.send(1, key)).rejects.toBeInstanceOf(CuaProcessError);
    await a.close();
    expect(replacement.transport.request).not.toHaveBeenCalled();
    expect((request.mock.calls.at(-1)![0] as any).request.type).toBe(
      "closeBinding",
    );
  });
  it("captures queued input values and serializes delivery", async () => {
    const { participants, request } = fixture();
    const a = await participants.open(binding("a"), targetRef);
    const pending = deferred<Awaited<ReturnType<CuaTransport["request"]>>>();
    request.mockImplementationOnce(() => pending.promise);
    const first = a.send(1, key);
    const event: InteractionEvent = {
      type: "pointerMove",
      data: { point: { x: 12, y: 34 }, modifiers: [] },
    };
    const second = a.send(2, event);
    event.data.point.x = 90;
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    pending.resolve(
      response({
        handle: 1,
        sequence: 1,
        outcome: "dispatched",
        windowDelivery: "unverified",
        cursor,
      }),
    );
    await Promise.all([first, second]);
    expect((request.mock.calls[2]![0] as any).request.event.data.point.x).toBe(
      12,
    );
  });
  it("shares the service runtime while agent cancellation leaves remote holds alone", async () => {
    const { runtime, request } = fixture();
    const launch = vi.fn(
      (_binary: string, _options?: CuaTransportOptions) => runtime.transport,
    );
    const service = new CantripCuaService({ workerId: "worker", launch });
    closes.push(() => service.close());
    const a = await service.participants.open(binding("a"), targetRef);
    service.cancelChat("chat");
    await a.send(1, key);
    expect(launch).toHaveBeenCalledOnce();
    expect(
      request.mock.calls.filter(
        ([o]) => (o as any).request?.type === "closeBinding",
      ),
    ).toHaveLength(0);
    service.disconnect();
    await a.close();
    await expect(a.send(2, key)).rejects.toMatchObject({ outcome: "not-sent" });
    service.reconnect();
    await service.participants.open(binding("new"), targetRef);
    expect(launch).toHaveBeenCalledOnce();
  });
  it("reports cancellation after dispatch as uncertain and cleans up", async () => {
    const { participants, request } = fixture();
    const a = await participants.open(binding("a"), targetRef);
    const signal = new AbortController();
    request.mockImplementationOnce(async () => {
      signal.abort();
      return response({
        handle: 1,
        sequence: 1,
        outcome: "dispatched",
        windowDelivery: "unverified",
        cursor,
      });
    });
    await expect(a.send(1, key, signal.signal)).rejects.toMatchObject({
      code: "cancelled",
      outcome: "unknown",
    });
    expect((request.mock.calls.at(-1)![0] as any).request.type).toBe(
      "closeBinding",
    );
  });
  it("rejects the wrong worker without starting a helper", async () => {
    const launch = vi.fn();
    const service = new CantripCuaService({ workerId: "worker", launch });
    closes.push(() => service.close());
    await expect(
      service.participants.open(
        { ...binding("a"), workerId: "other" },
        targetRef,
      ),
    ).rejects.toMatchObject({ code: "ownership-mismatch" });
    expect(launch).not.toHaveBeenCalled();
  });
});

describe.skipIf(!process.env.CANTRIP_CUA_TEST_BINARY)(
  "real helper participant protocol",
  () => {
    it("shares a helper with CUA discovery and cleans up rejected fake input", async () => {
      const service = new CantripCuaService({
        workerId: "worker",
        binary: process.env.CANTRIP_CUA_TEST_BINARY!,
        args: ["--backend", "fake"],
      });
      closes.push(() => service.close());
      const scope = {
        serverId: "server",
        ownerId: "owner",
        workerId: "worker",
        chatId: "chat",
        taskId: null,
        threadId: null,
        turnId: null,
      };
      const inventory = await service.targets(scope);
      expect(inventory.some((t) => t.id === "fake-window")).toBe(true);
      const a = await service.participants.open(binding("a"), "fake-window");
      const b = await service.participants.open(binding("b"), targetRef);
      await expect(a.send(1, key)).rejects.toMatchObject({
        code: "unsupported",
      });
      await b.close();
      expect(service.status().processGeneration).toBe(1);
      expect((await service.targets(scope)).length).toBeGreaterThan(0);
    });
  },
);
