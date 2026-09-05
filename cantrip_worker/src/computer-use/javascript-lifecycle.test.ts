import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CuaNativeError, CuaProcessError } from "./errors.js";
import type { CuaJavascriptOptions } from "./javascript.js";
import { CantripCuaService } from "./service.js";
import type { CuaRequestOptions, CuaTransportOptions } from "./transport.js";
import {
  CUA_REQUIRED_OPERATIONS,
  type CuaBinding,
  type CuaScope,
  type CuaSession,
} from "./types.js";

const scope: CuaScope = {
  serverId: "server",
  ownerId: "owner",
  workerId: "worker",
  chatId: "chat",
  taskId: "task",
  threadId: "thread",
  turnId: "turn",
};
const target = { targetId: "window", targetGeneration: 1 };
const capabilities = {
  protocolVersion: 1,
  runtimeVersion: "1.0.0",
  backend: "fake",
  capture: true,
  nativeInput: false,
  javascript: true,
  cursorAppearanceVersion: 1,
  operations: [
    ...CUA_REQUIRED_OPERATIONS,
    "javascript.evaluate",
    "javascript.reset",
  ],
  maxSessions: 16,
  maxImageBytes: 16 * 1024 * 1024,
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1QAAAAASUVORK5CYII=",
  "base64",
);
const services: CantripCuaService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  vi.restoreAllMocks();
});
function options(controller = new AbortController()): CuaJavascriptOptions {
  return {
    executionSignal: controller.signal,
    authorize: vi.fn(async () => {}),
  };
}
function session(binding: CuaBinding): CuaSession {
  return {
    binding,
    target: {
      id: target.targetId,
      generation: 1,
      kind: "window",
      title: "Fixture",
      application: "Fixture",
      processId: 1,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      pixelWidth: 1,
      pixelHeight: 1,
      scaleFactor: 1,
      focused: true,
      minimized: false,
    },
    cursor: {
      appearance: {
        version: 1,
        style: "arrow",
        color: "#FF0055",
        size: 24,
        label: null,
        trail: false,
        visible: true,
      },
      position: { x: 0, y: 0 },
      trailPoints: [],
      updatedAtMs: 0,
      revision: 1,
    },
    observationRevision: 0,
  };
}

// Only the process transport is controlled. Ownership, native session tracking,
// result validation and cancellation all run through the real worker service.
function fixture() {
  let onFailure: CuaTransportOptions["onFailure"];
  const nativeSessions = new Map<string, CuaSession>();
  const payloads: Buffer[] = [];
  let snapshotBytes = png.length;
  let beforeSnapshot: (() => void) | undefined;
  let evaluate = async (
    _source: string,
    _opts: CuaRequestOptions,
  ): Promise<unknown> => null;
  const request = vi.fn(
    async (input: unknown, opts: CuaRequestOptions = {}) => {
      const command = input as {
        operation: string;
        binding: CuaBinding;
        source: string;
      };
      let data: unknown;
      let payload = Buffer.alloc(0);
      switch (command.operation) {
        case "capabilities.get":
          data = capabilities;
          break;
        case "javascript.evaluate":
          data = { value: await evaluate(command.source, opts) };
          break;
        case "target.attach": {
          const current = session(command.binding);
          nativeSessions.set(command.binding.sessionId, current);
          data = { session: current };
          break;
        }
        case "observation.snapshot": {
          beforeSnapshot?.();
          const current = nativeSessions.get(command.binding.sessionId)!;
          // Padding exercises aggregate transport bytes, not native PNG decoding.
          payload = Buffer.alloc(snapshotBytes, 0x6b);
          png.copy(payload);
          payloads.push(payload);
          data = {
            session: {
              ...current,
              observationRevision: current.observationRevision + 1,
            },
            image: {
              mediaType: "image/png",
              width: 1,
              height: 1,
              byteCount: payload.length,
              sha256: createHash("sha256").update(payload).digest("hex"),
              cursorIncluded: true,
            },
          };
          break;
        }
        case "session.close":
          nativeSessions.delete(command.binding.sessionId);
          data = { closed: true };
          break;
        default:
          data = { reset: true };
      }
      return { data, payload };
    },
  );
  const service = new CantripCuaService({
    workerId: scope.workerId,
    launch: vi.fn((_binary: string, opts: CuaTransportOptions = {}) => {
      onFailure = opts.onFailure;
      return { closed: false, request, close: async () => {} };
    }),
  });
  services.push(service);
  return {
    service,
    nativeSessions,
    payloads,
    request,
    failRuntime: () => onFailure!(new CuaProcessError("process-exited")),
    setEvaluate: (handler: typeof evaluate) => {
      evaluate = handler;
    },
    setSnapshotBytes: (bytes: number) => {
      snapshotBytes = bytes;
    },
    beforeSnapshot: (handler: typeof beforeSnapshot) => {
      beforeSnapshot = handler;
    },
  };
}
function host(opts: CuaRequestOptions, action: unknown) {
  return opts.onHostCall!(action, opts.signal!);
}
async function attach(opts: CuaRequestOptions) {
  return host(opts, { operation: "attach", target });
}

describe("JavaScript lifetime and reset regressions", () => {
  it.each(["reset", "script error", "runtime failure", "native session close"])(
    "exposes the actual attached context signal and aborts it on %s without ending the native turn",
    async (ending) => {
      const { service, setEvaluate, request, failRuntime } = fixture();
      const opts = options();
      expect(
        service.javascriptSessionSignal(scope, opts.executionSignal),
      ).toBeNull();
      expect(request).not.toHaveBeenCalled();
      setEvaluate(async (_source, requestOptions) => attach(requestOptions));
      await service.evaluateJavascript(scope, "attach", opts);
      const signal = service.javascriptSessionSignal(
        scope,
        opts.executionSignal,
      )!;
      expect(signal.aborted).toBe(false);
      expect(() =>
        service.javascriptSessionSignal(scope, new AbortController().signal),
      ).toThrow();
      if (ending === "reset")
        await service.resetJavascript(scope, opts.executionSignal);
      if (ending === "script error") {
        setEvaluate(async () => {
          throw new CuaNativeError("invalid-request");
        });
        await expect(
          service.evaluateJavascript(scope, "fail", opts),
        ).rejects.toThrow();
      }
      if (ending === "runtime failure") failRuntime();
      if (ending === "native session close") {
        const current = service.javascriptSession(scope, opts.executionSignal)!;
        service.stopSession(scope, current.binding.sessionId);
      }
      expect(signal.aborted).toBe(true);
      expect(opts.executionSignal.aborted).toBe(false);
      expect(
        service.javascriptSessionSignal(scope, opts.executionSignal),
      ).toBeNull();
    },
  );

  it.each(["reset", "script-error"])(
    "Stop after %s still revokes the same actual execution signal",
    async (ending) => {
      const { service, setEvaluate, request } = fixture();
      const opts = options();
      if (ending === "script-error") {
        setEvaluate(async () => {
          throw new CuaNativeError("invalid-request");
        });
        await expect(
          service.evaluateJavascript(scope, "fail", opts),
        ).rejects.toMatchObject({ code: "invalid-request" });
      } else {
        await service.evaluateJavascript(scope, "ok", opts);
        await service.resetJavascript(scope, opts.executionSignal);
      }
      service.cancelScope(scope);
      const calls = request.mock.calls.length;
      await expect(
        service.evaluateJavascript(scope, "again", opts),
      ).rejects.toMatchObject({ code: "cancelled" });
      expect(request).toHaveBeenCalledTimes(calls);
      setEvaluate(async () => null);
      await expect(
        service.evaluateJavascript(
          { ...scope, turnId: "new-turn" },
          "ok",
          options(),
        ),
      ).resolves.toEqual({ value: null, images: [] });
    },
  );

  it("closes an attachment that settled immediately before reset", async () => {
    const { service, setEvaluate, nativeSessions } = fixture();
    const opts = options();
    setEvaluate(async (_source, requestOptions) => attach(requestOptions));
    const open = service.open.bind(service);
    let resetting = Promise.resolve();
    vi.spyOn(service, "open").mockImplementationOnce(async (...args) => {
      const opened = await open(...args);
      resetting = Promise.resolve(
        service.resetJavascript(scope, opts.executionSignal),
      );
      return opened;
    });
    await expect(
      service.evaluateJavascript(scope, "attach", opts),
    ).rejects.toMatchObject({ code: "cancelled" });
    await resetting;
    expect(nativeSessions.size).toBe(0);
    expect(service.javascriptSession(scope, opts.executionSignal)).toBeNull();
    await service.evaluateJavascript(scope, "attach-again", opts);
    expect(nativeSessions.size).toBe(1);
  });

  it("per-call cancellation disposes state but only explicit Stop revokes the turn", async () => {
    const { service, setEvaluate, beforeSnapshot, nativeSessions } = fixture();
    const opts = options();
    setEvaluate(async (source, requestOptions) => {
      if (source === "attach") return attach(requestOptions);
      return host(requestOptions, { operation: "snapshot" });
    });
    await service.evaluateJavascript(scope, "attach", opts);
    const call = new AbortController();
    beforeSnapshot(() => {
      call.abort();
      throw new CuaProcessError("cancelled", "unknown");
    });
    await expect(
      service.evaluateJavascript(scope, "snapshot", {
        ...opts,
        signal: call.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(nativeSessions.size).toBe(0);
    beforeSnapshot(undefined);
    await service.evaluateJavascript(scope, "attach", opts);
    const current = service.javascriptSession(scope, opts.executionSignal)!;
    service.stopSession(scope, current.binding.sessionId);
    expect(nativeSessions.size).toBe(0);
    await expect(
      service.evaluateJavascript(scope, "attach", opts),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("bounds retained reset lifetimes and frees a slot when the actual turn ends", async () => {
    const { service } = fixture();
    const executions = Array.from({ length: 17 }, (_, index) => ({
      scope: { ...scope, turnId: `turn-${index}` },
      controller: new AbortController(),
    }));
    for (const execution of executions.slice(0, 16)) {
      await service.evaluateJavascript(
        execution.scope,
        "ok",
        options(execution.controller),
      );
      await service.resetJavascript(
        execution.scope,
        execution.controller.signal,
      );
    }
    const next = executions[16]!;
    await expect(
      service.evaluateJavascript(next.scope, "ok", options(next.controller)),
    ).rejects.toMatchObject({ code: "capacity" });
    executions[0]!.controller.abort();
    await expect(
      service.evaluateJavascript(next.scope, "ok", options(next.controller)),
    ).resolves.toMatchObject({ value: null });
    service.cancelChat(scope.chatId);
    await expect(
      service.evaluateJavascript(next.scope, "again", options(next.controller)),
    ).rejects.toMatchObject({ code: "cancelled" });
    await expect(
      service.evaluateJavascript(
        { ...scope, turnId: "after-stop" },
        "ok",
        options(),
      ),
    ).resolves.toMatchObject({ value: null });
  });
});

describe("worker-owned JavaScript snapshot disposal", () => {
  it("returns only actual worker captures, not an image claimed by script output", async () => {
    const { service, setEvaluate, payloads } = fixture();
    const forged = { images: [{ payload: "forged" }], imageIndex: 99 };
    setEvaluate(async () => forged);
    const opts = options();
    expect(await service.evaluateJavascript(scope, "forged", opts)).toEqual({
      value: forged,
      images: [],
    });
    setEvaluate(async (_source, requestOptions) => {
      await attach(requestOptions);
      return host(requestOptions, { operation: "snapshot" });
    });
    const result = await service.evaluateJavascript(scope, "capture", opts);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.payload).toBe(payloads[0]);
    expect(result.images[0]!.payload.equals(png)).toBe(true);
    expect(result.value).toMatchObject({
      imageIndex: 0,
      image: { width: 1, height: 1 },
    });
    expect(result.value).not.toHaveProperty("payload");
  });

  it.each(["script-error", "aggregate-cap", "late-cancel"])(
    "wipes all discarded snapshots on %s",
    async (failure) => {
      const { service, setEvaluate, setSnapshotBytes, payloads } = fixture();
      const opts = options();
      const call = new AbortController();
      if (failure === "aggregate-cap") setSnapshotBytes(9 * 1024 * 1024);
      if (failure === "late-cancel") {
        const snapshot = service.snapshot.bind(service);
        vi.spyOn(service, "snapshot").mockImplementation(async (...args) => {
          const captured = await snapshot(...args);
          if (payloads.length === 2) call.abort();
          return captured;
        });
      }
      setEvaluate(async (_source, requestOptions) => {
        await attach(requestOptions);
        await host(requestOptions, { operation: "snapshot" });
        if (failure === "script-error")
          throw new CuaNativeError("invalid-request");
        return host(requestOptions, { operation: "snapshot" });
      });
      await expect(
        service.evaluateJavascript(scope, "capture-fails", {
          ...opts,
          signal: call.signal,
        }),
      ).rejects.toMatchObject({
        code:
          failure === "script-error"
            ? "invalid-request"
            : failure === "aggregate-cap"
              ? "capacity"
              : "cancelled",
      });
      expect(payloads).toHaveLength(failure === "script-error" ? 1 : 2);
      for (const payload of payloads)
        expect(payload.equals(Buffer.alloc(payload.length))).toBe(true);
      expect(service.javascriptSession(scope, opts.executionSignal)).toBeNull();
    },
  );
});
