import { afterEach, describe, expect, it, vi } from "vitest";
import { CantripCuaService } from "./service.js";
import { launchCuaTransport, type CuaRequestOptions } from "./transport.js";
import { CuaNativeError, CuaProcessError } from "./errors.js";
import {
  cuaJavascriptActionSchema,
  type CuaJavascriptOptions,
  CUA_JAVASCRIPT_MAX_SOURCE_BYTES,
} from "./javascript.js";
import { CUA_REQUIRED_OPERATIONS, type CuaScope } from "./types.js";

const scope: CuaScope = {
  serverId: "server",
  ownerId: "owner",
  workerId: "worker",
  chatId: "chat",
  taskId: "task",
  threadId: "thread",
  turnId: "turn",
};
const capability = {
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
const services: CantripCuaService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function options(controller = new AbortController()) {
  return {
    executionSignal: controller.signal,
    authorize: vi.fn<CuaJavascriptOptions["authorize"]>(async () => {}),
  };
}
function fixture(
  evaluate: (options: CuaRequestOptions) => Promise<unknown> = async () => null,
) {
  const request = vi.fn(
    async (input: unknown, opts: CuaRequestOptions = {}) => {
      const operation = (input as { operation: string }).operation;
      const data =
        operation === "capabilities.get"
          ? capability
          : operation === "javascript.evaluate"
            ? { value: await evaluate(opts) }
            : operation === "targets.list"
              ? { targets: [] }
              : { reset: true };
      return { data, payload: Buffer.alloc(0) };
    },
  );
  const launch = vi.fn(() => ({
    closed: false,
    request,
    close: vi.fn(async () => {}),
  }));
  const service = new CantripCuaService({ workerId: "worker", launch });
  services.push(service);
  return { service, launch, request };
}

describe("bounded CUA JavaScript host arguments", () => {
  it.each(["state", "targets", "snapshot", "cursor", "detach", "controls"])(
    "accepts %s without authority fields",
    (operation) => {
      expect(cuaJavascriptActionSchema.parse({ operation })).toEqual({
        operation,
      });
      expect(
        cuaJavascriptActionSchema.safeParse({ operation, workerId: "other" })
          .success,
      ).toBe(false);
      expect(
        cuaJavascriptActionSchema.safeParse({ operation, sessionId: "other" })
          .success,
      ).toBe(false);
    },
  );
  it("accepts bounded point inspection without input or authority fields", () => {
    expect(
      cuaJavascriptActionSchema.parse({
        operation: "controls",
        point: { x: 54, y: 955 },
      }),
    ).toEqual({ operation: "controls", point: { x: 54, y: 955 } });
    for (const point of [
      { x: Infinity, y: 0 },
      { x: 0, y: NaN },
    ])
      expect(
        cuaJavascriptActionSchema.safeParse({ operation: "controls", point })
          .success,
      ).toBe(false);
    expect(
      cuaJavascriptActionSchema.safeParse({
        operation: "controls",
        point: { x: 1, y: 1 },
        sessionId: "other",
      }).success,
    ).toBe(false);
  });
  it("validates target, position and appearance with the native shared contract", () => {
    const target = { targetId: "window", targetGeneration: 1 };
    expect(
      cuaJavascriptActionSchema.parse({ operation: "attach", target }),
    ).toEqual({ operation: "attach", target });
    for (const targetGeneration of [
      0,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(
        cuaJavascriptActionSchema.safeParse({
          operation: "attach",
          target: { ...target, targetGeneration },
        }).success,
      ).toBe(false);
    expect(
      cuaJavascriptActionSchema.safeParse({
        operation: "moveCursor",
        point: { x: 0, y: 0 },
      }).success,
    ).toBe(true);
    expect(
      cuaJavascriptActionSchema.safeParse({
        operation: "moveCursor",
        point: { x: Infinity, y: 0 },
      }).success,
    ).toBe(false);
    for (const style of ["arrow", "dot", "ring", "crosshair"]) {
      const appearance = {
        version: 1,
        style,
        color: "#FF0055AA",
        size: 96,
        label: "Agent",
        trail: true,
        visible: true,
      };
      expect(
        cuaJavascriptActionSchema.safeParse({
          operation: "configureCursor",
          appearance,
        }).success,
      ).toBe(true);
      expect(
        cuaJavascriptActionSchema.safeParse({
          operation: "configureCursor",
          appearance: { ...appearance, size: 97 },
        }).success,
      ).toBe(false);
    }
    for (const operation of [
      "globalClick",
      "type",
      "exec",
      "fetch",
      "close",
      "javascript.evaluate",
    ])
      expect(cuaJavascriptActionSchema.safeParse({ operation }).success).toBe(
        false,
      );
  });
});

describe("worker JavaScript ownership before MCP activation", () => {
  it.each([false, true])(
    "preserves a host deadline cause but lets actual Stop win (%s)",
    async (stop) => {
      const controller = new AbortController();
      const timeout = new CuaProcessError("timeout");
      const { service } = fixture(async ({ onHostCall }) => {
        try {
          await onHostCall!({ operation: "targets" }, controller.signal);
        } catch {
          if (stop) controller.abort();
          // This is the native host-result wire's timeout-to-cancel mapping.
          throw new CuaNativeError("cancelled");
        }
      });
      await expect(
        service.evaluateJavascript(scope, "await cua.targets()", {
          ...options(controller),
          authorize: async () => {
            throw timeout;
          },
        }),
      ).rejects.toMatchObject({ code: stop ? "cancelled" : "timeout" });
    },
  );

  it.each([undefined, 0, 1, 7_500_000])(
    "propagates trusted wall timeout %s to Rust and the host transport",
    async (wallTimeoutMs) => {
      const { service, request } = fixture();
      await service.evaluateJavascript(scope, "1", {
        ...options(),
        wallTimeoutMs,
      });
      const call = request.mock.calls.find(
        ([input]) =>
          (input as { operation: string }).operation === "javascript.evaluate",
      )!;
      const expected = wallTimeoutMs ?? 0;
      expect(call[0]).toMatchObject({
        operation: "javascript.evaluate",
        wallTimeoutMs: expected,
      });
      expect(call[1]).toMatchObject({
        timeoutMs: expected === 0 ? 0 : expected + 2_000,
      });
    },
  );

  it.each([-1, 7_500_001, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid trusted wall timeout %s before launching or creating authority",
    async (wallTimeoutMs) => {
      const { service, launch } = fixture();
      const opts = options();
      await expect(
        service.evaluateJavascript(scope, "1", { ...opts, wallTimeoutMs }),
      ).rejects.toMatchObject({ code: "invalid-request", outcome: "not-sent" });
      expect(launch).not.toHaveBeenCalled();
      expect(service.javascriptSession(scope, opts.executionSignal)).toBeNull();
      // Invalid input did not bind the original lifetime or consume a context.
      await service.evaluateJavascript(scope, "1", options());
      expect(launch).toHaveBeenCalledTimes(1);
    },
  );

  it("stays lazy, including reset, and rejects invalid source before launch", async () => {
    const { service, launch } = fixture();
    const opts = options();
    await service.resetJavascript(scope, opts.executionSignal);
    expect(service.javascriptSession(scope, opts.executionSignal)).toBeNull();
    await expect(
      service.evaluateJavascript(
        scope,
        "x".repeat(CUA_JAVASCRIPT_MAX_SOURCE_BYTES + 1),
        opts,
      ),
    ).rejects.toMatchObject({ code: "invalid-request" });
    await expect(
      service.evaluateJavascript(
        scope,
        "😀".repeat(CUA_JAVASCRIPT_MAX_SOURCE_BYTES / 4 + 1),
        opts,
      ),
    ).rejects.toMatchObject({ code: "invalid-request" });
    await expect(
      service.evaluateJavascript({ ...scope, workerId: "client" }, "1", opts),
    ).rejects.toMatchObject({ code: "ownership-mismatch" });
    await expect(
      service.evaluateJavascript({ ...scope, turnId: null }, "1", opts),
    ).rejects.toMatchObject({ code: "ownership-mismatch" });
    expect(launch).not.toHaveBeenCalled();
    await service.evaluateJavascript(
      scope,
      " ".repeat(CUA_JAVASCRIPT_MAX_SOURCE_BYTES),
      opts,
    );
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it("fences exact scope and actual execution signal, preserving one context across calls", async () => {
    const { service, request } = fixture();
    const opts = options();
    await service.evaluateJavascript(scope, "1", opts);
    await service.evaluateJavascript(scope, "2", opts);
    const evaluations = request.mock.calls.filter(
      ([op]) =>
        (op as { operation: string }).operation === "javascript.evaluate",
    );
    expect(evaluations[0]![0]).toMatchObject({
      binding: {
        chatId: scope.chatId,
        threadId: scope.threadId,
        turnId: scope.turnId,
      },
    });
    expect((evaluations[0]![0] as { binding: unknown }).binding).toEqual(
      (evaluations[1]![0] as { binding: unknown }).binding,
    );
    await expect(
      service.evaluateJavascript(scope, "3", options()),
    ).rejects.toMatchObject({ code: "ownership-mismatch" });
    await expect(
      service.evaluateJavascript({ ...scope, ownerId: "other" }, "3", opts),
    ).rejects.toMatchObject({ code: "ownership-mismatch" });
    expect(
      request.mock.calls.filter(
        ([op]) =>
          (op as { operation: string }).operation === "javascript.evaluate",
      ),
    ).toHaveLength(2);
  });
  it("cancels a macro delay before any following action", async () => {
    const controller = new AbortController();
    const after = vi.fn();
    const { service } = fixture(async (opts) => {
      const waiting = opts.onHostCall!(
        { operation: "wait", ms: 10000 },
        controller.signal,
      );
      controller.abort();
      await waiting;
      after();
    });
    await expect(
      service.evaluateJavascript(scope, "timed sequence", options()),
    ).rejects.toBeDefined();
    expect(after).not.toHaveBeenCalled();
  });
  it("runs a bounded delay in the host without sending native input", async () => {
    const { service, request } = fixture(async (opts) =>
      opts.onHostCall!(
        { operation: "wait", ms: 1 },
        new AbortController().signal,
      ),
    );
    const result = await service.evaluateJavascript(
      scope,
      "timed sequence",
      options(),
    );
    expect(result.value).toEqual({ waitedMs: 1 });
    expect(
      request.mock.calls.some(([op]) =>
        String((op as { operation: string }).operation).startsWith("input."),
      ),
    ).toBe(false);
  });
  it("authorizes each parsed host call before the real operation", async () => {
    const { service, request } = fixture(async (opts) => {
      await opts.onHostCall!(
        { operation: "state" },
        new AbortController().signal,
      );
      return opts.onHostCall!(
        { operation: "targets" },
        new AbortController().signal,
      );
    });
    const opts = options();
    expect(await service.evaluateJavascript(scope, "test", opts)).toEqual({
      value: { targets: [] },
      images: [],
    });
    expect(opts.authorize.mock.calls.map(([action]) => action)).toEqual([
      { operation: "state" },
      { operation: "targets" },
    ]);
    expect(
      request.mock.calls.filter(
        ([op]) => (op as { operation: string }).operation === "targets.list",
      ),
    ).toHaveLength(1);
  });
  it("authorizes and forwards the bounded inventory cursor to the same native service", async () => {
    const { service, request } = fixture(async (opts) =>
      opts.onHostCall!(
        { operation: "targets", after: "macos-window-123" },
        new AbortController().signal,
      ),
    );
    const opts = options();
    await service.evaluateJavascript(scope, "test", opts);
    expect(opts.authorize).toHaveBeenCalledWith(
      { operation: "targets", after: "macos-window-123" },
      expect.any(AbortSignal),
    );
    expect(
      request.mock.calls.some(
        ([operation]) =>
          (operation as { operation: string; after?: string }).operation ===
            "targets.list" &&
          (operation as { after?: string }).after === "macos-window-123",
      ),
    ).toBe(true);
  });
  it("rejects supplied execution authority before calling policy or native code", async () => {
    const { service, request } = fixture(async (opts) =>
      opts.onHostCall!(
        { operation: "targets", turnId: "forged" },
        new AbortController().signal,
      ),
    );
    const opts = options();
    await expect(
      service.evaluateJavascript(scope, "test", opts),
    ).rejects.toMatchObject({ code: "script-action" });
    expect(opts.authorize).not.toHaveBeenCalled();
    expect(
      request.mock.calls.filter(
        ([op]) => (op as { operation: string }).operation === "targets.list",
      ),
    ).toHaveLength(0);
  });
  it("rejects denied host actions without attempting the underlying operation", async () => {
    const { service, request } = fixture(async (opts) =>
      opts.onHostCall!({ operation: "targets" }, new AbortController().signal),
    );
    const opts = {
      ...options(),
      authorize: vi.fn(async () => {
        throw new CuaNativeError("permission-denied");
      }),
    };
    await expect(
      service.evaluateJavascript(scope, "test", opts),
    ).rejects.toMatchObject({ code: "permission-denied" });
    expect(
      request.mock.calls.filter(
        ([op]) => (op as { operation: string }).operation === "targets.list",
      ),
    ).toHaveLength(0);
  });
  it.each(["scope", "chat", "thread", "disconnect"] as const)(
    "%s revokes inventory-only YOLO contexts without a preview or approval",
    async (kind) => {
      const { service, request } = fixture();
      const opts = options();
      await service.evaluateJavascript(scope, "1", opts);
      if (kind === "scope") service.cancelScope(scope);
      if (kind === "chat") service.cancelChat(scope.chatId);
      if (kind === "thread") service.cancelThread(scope.threadId!);
      if (kind === "disconnect") {
        service.disconnect();
        service.reconnect();
      }
      await service.resetJavascript(scope, opts.executionSignal); // Reset does not undo revocation.
      await expect(
        service.evaluateJavascript(scope, "2", opts),
      ).rejects.toMatchObject({ code: "cancelled" });
      expect(
        request.mock.calls.filter(
          ([op]) =>
            (op as { operation: string }).operation === "javascript.evaluate",
        ),
      ).toHaveLength(1);
    },
  );
  it("reset clears a context but permits a new one in the same live turn", async () => {
    const { service, request } = fixture();
    const opts = options();
    await service.evaluateJavascript(scope, "1", opts);
    await service.resetJavascript(scope, opts.executionSignal);
    await service.evaluateJavascript(scope, "2", opts);
    const evaluations = request.mock.calls.filter(
      ([op]) =>
        (op as { operation: string }).operation === "javascript.evaluate",
    );
    expect((evaluations[0]![0] as { binding: unknown }).binding).not.toEqual(
      (evaluations[1]![0] as { binding: unknown }).binding,
    );
  });
  it("cancels while approval is pending and cannot resume on a late approval", async () => {
    const entered = deferred<void>();
    const approved = deferred<void>();
    const { service, request } = fixture(async (opts) =>
      opts.onHostCall!({ operation: "targets" }, new AbortController().signal),
    );
    const opts = {
      ...options(),
      authorize: vi.fn(async () => {
        entered.resolve();
        await approved.promise;
      }),
    };
    const result = service.evaluateJavascript(scope, "test", opts);
    const cancelled = expect(result).rejects.toMatchObject({
      code: "cancelled",
    });
    await entered.promise;
    // The outer evaluation does not hold a native queue or reserve every slot.
    expect(await service.inventory({ ...scope, turnId: "other" })).toEqual({
      targets: [],
    });
    service.cancelScope(scope);
    await cancelled;
    approved.resolve();
    await Promise.resolve();
    expect(
      request.mock.calls.filter(
        ([op]) => (op as { operation: string }).operation === "targets.list",
      ),
    ).toHaveLength(1);
    await expect(
      service.evaluateJavascript(scope, "retry", opts),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
  it("preview null identities do not cancel an agent context", async () => {
    const { service } = fixture();
    const opts = options();
    await service.evaluateJavascript(scope, "1", opts);
    service.cancelScope({
      ...scope,
      taskId: null,
      threadId: null,
      turnId: null,
    });
    await expect(
      service.evaluateJavascript(scope, "2", opts),
    ).resolves.toMatchObject({ value: null });
  });
  it("admits four contexts, rejects a fifth, and frees capacity on reset", async () => {
    const { service } = fixture();
    const owners = Array.from({ length: 5 }, (_, i) => ({
      scope: { ...scope, turnId: `turn-${i}` },
      opts: options(),
    }));
    for (const owner of owners.slice(0, 4))
      await service.evaluateJavascript(owner.scope, "1", owner.opts);
    await expect(
      service.evaluateJavascript(owners[4]!.scope, "1", owners[4]!.opts),
    ).rejects.toMatchObject({ code: "capacity" });
    await service.resetJavascript(
      owners[0]!.scope,
      owners[0]!.opts.executionSignal,
    );
    await expect(
      service.evaluateJavascript(owners[4]!.scope, "1", owners[4]!.opts),
    ).resolves.toMatchObject({ value: null });
  });
  it("keeps a retiring engine reserved until its real reset acknowledgment", async () => {
    const { service, request } = fixture();
    const owners = Array.from({ length: 5 }, (_, i) => ({
      scope: { ...scope, turnId: `turn-${i}` },
      opts: options(),
    }));
    for (const owner of owners.slice(0, 4))
      await service.evaluateJavascript(owner.scope, "1", owner.opts);
    const reset = deferred<void>();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (input, opts) => {
      if ((input as { operation: string }).operation === "javascript.reset")
        await reset.promise;
      return original(input, opts);
    });
    const retiring = service.resetJavascript(
      owners[0]!.scope,
      owners[0]!.opts.executionSignal,
    );
    await expect(
      service.evaluateJavascript(owners[4]!.scope, "1", owners[4]!.opts),
    ).rejects.toMatchObject({ code: "capacity" });
    reset.resolve();
    await retiring;
    await expect(
      service.evaluateJavascript(owners[4]!.scope, "1", owners[4]!.opts),
    ).resolves.toMatchObject({ value: null });
  });
  it.each([32 * 1024, 32 * 1024 + 1])(
    "validates the full %i-byte evaluation result",
    async (bytes) => {
      const { service } = fixture(async () => "x".repeat(bytes - 12));
      const result = service.evaluateJavascript(scope, "test", options());
      if (bytes === 32 * 1024) {
        expect((await result).value).toHaveLength(bytes - 12);
      } else {
        await expect(result).rejects.toMatchObject({ code: "protocol-error" });
        expect(service.status().state).toBe("restart-available");
      }
    },
  );
});

describe.skipIf(!process.env.CANTRIP_CUA_TEST_BINARY)(
  "JavaScript -> authorized worker -> actual Rust fake capture",
  () => {
    function create() {
      const launch = vi.fn(launchCuaTransport);
      const service = new CantripCuaService({
        workerId: "worker",
        binary: process.env.CANTRIP_CUA_TEST_BINARY!,
        args: ["--backend", "fake"],
        launch,
      });
      services.push(service);
      return { service, launch };
    }
    it.each([false, true])(
      "preserves macOS dispatch receipts and identifies genuine protocol failures (%s)",
      async (corrupt) => {
        let session: unknown;
        let performed = 0;
        const launch = vi.fn<typeof launchCuaTransport>((binary, config) => {
          const transport = launchCuaTransport(binary, config);
          return {
            get closed() {
              return transport.closed;
            },
            close: () => transport.close(),
            request: async (input, opts) => {
              const operation = input as {
                operation: string;
                command?: { kind: string; point?: { x: number; y: number } };
              };
              if (operation.operation === "input.perform") {
                performed++;
                // Real QuickJS + native fake capture, with the receipt emitted by
                // macOS substituted for the fake backend's unsupported input.
                const point = operation.command?.point ?? { x: 10, y: 20 };
                return {
                  payload: Buffer.alloc(0),
                  data: {
                    session,
                    input: {
                      method:
                        corrupt && performed === 1
                          ? "background-key"
                          : `background-${operation.command!.kind}`,
                      activation: operation.command!.kind === "prepared-press",
                      outcome: "dispatched",
                      windowDelivery: "unverified",
                      position: point,
                      globalPosition: point,
                    },
                  },
                };
              }
              const response = await transport.request(input, opts);
              if (
                response.data &&
                typeof response.data === "object" &&
                "session" in response.data
              )
                session = response.data.session;
              return response;
            },
          };
        });
        const service = new CantripCuaService({
          workerId: "worker",
          binary: process.env.CANTRIP_CUA_TEST_BINARY!,
          args: ["--backend", "fake"],
          launch,
        });
        services.push(service);
        const opts = options();
        await service.evaluateJavascript(
          scope,
          "await cua.attach({targetId:'fake-window',targetGeneration:1})",
          opts,
        );
        if (corrupt) {
          await expect(
            service.evaluateJavascript(
              scope,
              "await cua.click({x:10,y:20}); await cua.click({x:10,y:20})",
              opts,
            ),
          ).rejects.toMatchObject({
            code: "protocol-error",
            message: expect.stringContaining(
              "A worker restart is not required",
            ),
          });
          expect(performed).toBe(1);
          await service.evaluateJavascript(
            scope,
            "await cua.attach({targetId:'fake-window',targetGeneration:1}); await cua.snapshot()",
            opts,
          );
          expect(launch).toHaveBeenCalledTimes(2);
          expect(performed).toBe(1); // Recovery observes; it never replays input.
          return;
        }
        const result = await service.evaluateJavascript(
          scope,
          "await cua.click({x:10,y:20}); await cua.click({x:10,y:20}); await cua.snapshot()",
          opts,
        );
        expect(result.images).toHaveLength(1);
        expect(performed).toBe(2);
        expect(service.status()).toMatchObject({
          state: "running",
          sessions: 1,
          lastFailure: null,
        });
        expect(launch).toHaveBeenCalledTimes(1);
      },
    );
    it("compiles click sequences to one authorized timeline with no setup or capture", async () => {
      const { service } = create();
      const opts = options();
      await service.evaluateJavascript(
        scope,
        "await cua.attach({targetId:'fake-window',targetGeneration:1})",
        opts,
      );
      opts.authorize.mockClear();
      await expect(
        service.evaluateJavascript(
          scope,
          "await cua.clickSequence([{atMs:100,x:10,y:20},{atMs:150000,x:30,y:40}],{holdMs:25})",
          opts,
        ),
      ).rejects.toMatchObject({ code: "unsupported" }); // Fake backend cannot post input.
      expect(opts.authorize.mock.calls.map(([action]) => action)).toMatchObject(
        [
          {
            operation: "perform",
            command: {
              kind: "timeline",
              frames: [
                { atMs: 100, pointerDown: { x: 10, y: 20 } },
                { atMs: 125, pointerUp: true },
                { atMs: 150000, pointerDown: { x: 30, y: 40 } },
                { atMs: 150025, pointerUp: true },
              ],
            },
          },
        ],
      );
      opts.authorize.mockClear();
      await expect(
        service.evaluateJavascript(
          scope,
          "await cua.clickSequence([{atMs:0,x:10,y:20},{atMs:10,x:30,y:40}])",
          opts,
        ),
      ).rejects.toMatchObject({
        code: "script-action",
        message: expect.stringContaining("clicks[1] overlaps"),
      });
      expect(opts.authorize).not.toHaveBeenCalled();
      const help = await service.evaluateJavascript(
        scope,
        "cua.help('mouse')",
        opts,
      );
      expect(help.value).toMatchObject({
        apiVersion: 19,
        methods: { clickSequence: expect.any(String) },
        examples: { clickSequence: expect.any(String) },
      });
      expect((help.value as { examples: object }).examples).not.toHaveProperty(
        "commandK",
      );
      expect(opts.authorize).not.toHaveBeenCalled();
    });
    it("routes the reported Command-K variants past validation and returns targeted help", async () => {
      const { service } = create();
      const opts = options();
      await service.evaluateJavascript(
        scope,
        "await cua.attach({targetId:'fake-window',targetGeneration:1})",
        opts,
      );
      for (const script of [
        "await cua.keyPress('k', ['Meta'])",
        "await cua.keyChord(['Meta','k'])",
        "await cua.keyChord(['k'],500,['Meta'])",
      ]) {
        await expect(
          service.evaluateJavascript(scope, script, opts),
        ).rejects.toMatchObject({ code: "unsupported" }); // Fake backend deliberately cannot post keyboard input.
        expect(opts.authorize.mock.calls.at(-1)?.[0].operation).toBe("perform");
      }
      const result = await service.evaluateJavascript(
        scope,
        "cua.help('key')",
        opts,
      );
      expect(result.value).toMatchObject({
        apiVersion: 19,
        methods: { keyPress: expect.any(String), keyChord: expect.any(String) },
        examples: { commandK: expect.any(String) },
      });
      expect((result.value as { methods: object }).methods).not.toHaveProperty(
        "click",
      );
    });
    it("drops failed engine variables while reusing the authorized native attachment", async () => {
      const { service, launch } = create();
      const opts = options();
      await service.evaluateJavascript(
        scope,
        "let marker = 42; { const page = await cua.targets(); const t = page.targets[0]; await cua.attach({targetId:t.id,targetGeneration:t.generation}); }",
        opts,
      );
      const attached = service.javascriptSession(scope, opts.executionSignal)!;
      opts.authorize.mockImplementationOnce(async () => {
        throw new CuaNativeError("capture-image-timeout");
      });
      await expect(
        service.evaluateJavascript(scope, "await cua.snapshot()", opts),
      ).rejects.toMatchObject({ code: "capture-image-timeout" });
      const result = await service.evaluateJavascript(
        scope,
        "await cua.snapshot(); typeof marker",
        opts,
      );
      expect(result.value).toBe("undefined");
      expect(result.images[0]!.session.binding.sessionId).toBe(
        attached.binding.sessionId,
      );
      expect(launch).toHaveBeenCalledTimes(1);
    });

    it("preserves lexical variables and top-level await, then resets without relaunching", async () => {
      const { service, launch } = create();
      const opts = options();
      await service.evaluateJavascript(
        scope,
        "let count = 40; const targets = await cua.targets();",
        opts,
      );
      expect(
        (
          await service.evaluateJavascript(
            scope,
            "count += targets.targets.length; count",
            opts,
          )
        ).value,
      ).toBe(42);
      await service.resetJavascript(scope, opts.executionSignal);
      expect(
        (await service.evaluateJavascript(scope, "typeof count", opts)).value,
      ).toBe("undefined");
      expect(launch).toHaveBeenCalledTimes(1);
    });
    it("returns real PNG bytes separately from JavaScript and configures every cursor style", async () => {
      const { service } = create();
      const opts = options();
      await service.evaluateJavascript(
        scope,
        "await cua.attach({ targetId: 'fake-monitor', targetGeneration: 1 });",
        opts,
      );
      for (const style of ["arrow", "dot", "ring", "crosshair"]) {
        const result = await service.evaluateJavascript(
          scope,
          `
        await cua.configureCursor({ version: 1, style: '${style}', color: '#FF0055AA', size: 24, label: 'Agent', trail: true, visible: true });
        await cua.moveCursor({ x: 12, y: 13 });
        await cua.snapshot();
      `,
          opts,
        );
        expect(result.images).toHaveLength(1);
        expect(result.images[0]!.payload.subarray(0, 8)).toEqual(
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        );
        expect(result.images[0]!.session.cursor).toMatchObject({
          appearance: { style, label: "Agent" },
          position: { x: 12, y: 13 },
        });
        expect(result.value).toMatchObject({
          imageIndex: 0,
          image: { mediaType: "image/png", cursorIncluded: true },
        });
        expect(result.value).not.toHaveProperty("payload");
      }
      await service.evaluateJavascript(scope, "await cua.detach();", opts);
      expect(
        service.javascriptSession(scope, opts.executionSignal)?.target,
      ).toBeNull();
    });
    it("enforces snapshot count, clears images on failure, and keeps scripts isolated", async () => {
      const { service } = create();
      const opts = options();
      await service.evaluateJavascript(
        scope,
        "await cua.attach({ targetId: 'fake-window', targetGeneration: 1 }); let secret = 42;",
        opts,
      );
      const result = await service.evaluateJavascript(
        scope,
        "await cua.snapshot(); await cua.snapshot(); try { await cua.snapshot(); } catch { 'limited'; }",
        opts,
      );
      expect(result.images).toHaveLength(2);
      expect(result.value).toBe("limited");
      const other = options();
      expect(
        (
          await service.evaluateJavascript(
            { ...scope, turnId: "other" },
            "typeof secret",
            other,
          )
        ).value,
      ).toBe("undefined");
      await expect(
        service.evaluateJavascript(
          scope,
          "await cua.snapshot(); throw new Error('private-data');",
          opts,
        ),
      ).rejects.toBeInstanceOf(CuaNativeError);
      expect(
        service.javascriptSession(scope, opts.executionSignal)?.target?.id,
      ).toBe("fake-window");
      expect(
        (await service.evaluateJavascript(scope, "typeof secret", opts)).value,
      ).toBe("undefined");
    });
    it("ends an actual JS lifetime on native session Stop, even with no approval entry", async () => {
      const { service } = create();
      const opts = options();
      await service.evaluateJavascript(
        scope,
        "await cua.attach({ targetId: 'fake-monitor', targetGeneration: 1 });",
        opts,
      );
      service.stopSession(
        scope,
        service.javascriptSession(scope, opts.executionSignal)!.binding
          .sessionId,
      );
      await expect(
        service.evaluateJavascript(scope, "await cua.targets();", opts),
      ).rejects.toMatchObject({ code: "cancelled" });
    });
    it("interrupts an infinite JS job and still services a native inventory request", async () => {
      const { service } = create();
      const controller = new AbortController();
      const opts = options(controller);
      await service.evaluateJavascript(scope, "let ready = true;", opts);
      const running = service.evaluateJavascript(scope, "while(true) {}", opts);
      // On a heavily scheduled host the engine's two-second execution budget
      // may win before this process receives inventory and sends cancellation.
      const failed = expect(running).rejects.toMatchObject({
        code: expect.stringMatching(/^(?:cancelled|capacity)$/u),
      });
      const targets = await service.inventory({ ...scope, turnId: "observer" });
      expect(targets.targets).toHaveLength(2);
      controller.abort();
      await failed;
      expect(
        await service.inventory({ ...scope, turnId: "observer" }),
      ).toMatchObject({ targets: expect.any(Array) });
    });
  },
);

describe("CUA evaluation failure context", () => {
  it("distinguishes a search-script throw from mouse input and permits the next evaluation", async () => {
    let fail = true;
    const { service } = fixture(async (opts) => {
      await opts.onHostCall!(
        { operation: "targets" },
        new AbortController().signal,
      );
      if (fail) throw new CuaNativeError("script-evaluation");
      return "recovered";
    });
    const opts = options();
    await expect(
      service.evaluateJavascript(scope, "search", opts),
    ).rejects.toMatchObject({
      code: "script-evaluation",
      message: expect.stringContaining(
        "last requested operation: targets. No input operation was requested",
      ),
    });
    fail = false;
    await expect(
      service.evaluateJavascript(scope, "corrected search", opts),
    ).resolves.toMatchObject({ value: "recovered" });
  });
});

it("preserves native error codes and reports when an input method was requested", async () => {
  const { service } = fixture(async (opts) => {
    await opts.onHostCall!(
      { operation: "click", point: { x: 10, y: 20 } },
      new AbortController().signal,
    );
  });
  await expect(
    service.evaluateJavascript(scope, "click", options()),
  ).rejects.toMatchObject({
    code: "session-not-found",
    message: expect.stringContaining(
      "last requested operation: click. Input was requested",
    ),
  });
});
