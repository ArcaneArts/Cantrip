import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CantripCuaService } from "./service.js";
import { launchCuaTransport } from "./transport.js";
import { CuaNativeError, CuaProcessError } from "./errors.js";
import type { CuaScope, CuaCursorAppearance, CuaSnapshot } from "./types.js";

const scope: CuaScope = {
  serverId: "server",
  ownerId: "owner",
  workerId: "worker",
  chatId: "chat",
  taskId: "task",
  threadId: "thread",
  turnId: "turn",
};
const monitor = { targetId: "fake-monitor", targetGeneration: 1 };
const windowTarget = { targetId: "fake-window", targetGeneration: 1 };
const appearance: CuaCursorAppearance = {
  version: 1,
  style: "arrow",
  color: "#FF0055",
  size: 24,
  label: "Agent",
  trail: true,
  visible: true,
};
const services: CantripCuaService[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

describe("CUA worker composition without activation", () => {
  it("does no work at construction, idle disconnect, reconnect, or shutdown", async () => {
    const launch = vi.fn();
    const service = new CantripCuaService({ workerId: "worker", launch });
    expect(service.status()).toMatchObject({
      state: "idle",
      processGeneration: 0,
    });
    service.cancelChat("chat");
    service.disconnect();
    service.reconnect();
    const first = service.close();
    expect(service.close()).toBe(first);
    await first;
    expect(launch).not.toHaveBeenCalled();
    expect(service.status().state).toBe("closed");
  });
  it("rejects another worker before launching any helper", async () => {
    const launch = vi.fn();
    const service = new CantripCuaService({ workerId: "worker", launch });
    services.push(service);
    await expect(
      service.targets({ ...scope, workerId: "client-device" }),
    ).rejects.toMatchObject({ code: "ownership-mismatch" });
    expect(launch).not.toHaveBeenCalled();
  });
  it("attempts the explicit binary and reports its actual failure without fallback", async () => {
    const launch = vi.fn(launchCuaTransport);
    const service = new CantripCuaService({
      workerId: "worker",
      binary: "/missing-cua-test/executable",
      launch,
    });
    services.push(service);
    await expect(service.capabilities(scope)).rejects.toBeInstanceOf(
      CuaProcessError,
    );
    await expect(service.capabilities(scope)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(service.status()).toMatchObject({
      state: "failed",
      lastFailure: "spawn-failed",
    });
  });
  it("records synchronous launch failure rather than repeatedly trying to launch", async () => {
    const launch = vi.fn(launchCuaTransport);
    const service = new CantripCuaService({
      workerId: "worker",
      binary: "",
      launch,
    });
    services.push(service);
    await expect(service.capabilities(scope)).rejects.toMatchObject({
      code: "spawn-failed",
    });
    await expect(service.capabilities(scope)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(launch).toHaveBeenCalledTimes(1);
  });
});

// Explicit command pnpm cua:test:worker builds and passes the actual executable.
// Ordinary worker unit tests do not quietly build Rust or request native capture.
describe.skipIf(!process.env.CANTRIP_CUA_TEST_BINARY)(
  "worker -> actual Rust fake backend",
  () => {
    function create(
      options: {
        beforeRequest?: (operation: unknown) => void;
        transform?: (
          operation: unknown,
          response: { data: unknown; payload: Buffer },
        ) =>
          | { data: unknown; payload: Buffer }
          | Promise<{ data: unknown; payload: Buffer }>;
      } = {},
    ) {
      const children: ChildProcess[] = [];
      const operations: unknown[] = [];
      const launch = vi.fn<typeof launchCuaTransport>(
        (binary, transportOptions) => {
          const transport = launchCuaTransport(binary, {
            ...transportOptions,
            spawnProcess: ((...args: Parameters<typeof spawn>) => {
              const child = spawn(...args);
              children.push(child);
              return child;
            }) as typeof spawn,
          });
          return {
            get closed() {
              return transport.closed;
            },
            close: () => transport.close(),
            request: async (operation, requestOptions) => {
              operations.push(operation);
              options.beforeRequest?.(operation);
              const response = await transport.request(
                operation,
                requestOptions,
              );
              return options.transform?.(operation, response) ?? response;
            },
          };
        },
      );
      const service = new CantripCuaService({
        workerId: "worker",
        binary: process.env.CANTRIP_CUA_TEST_BINARY!,
        args: ["--backend", "fake"],
        launch,
      });
      services.push(service);
      return { service, launch, children, operations };
    }
    async function crash(child: ChildProcess) {
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
    it.each([undefined, false, true])(
      "preserves native inventory truncation %s while retaining array callers",
      async (truncated) => {
        const { service, launch } = create({
          transform: (operation, response) => {
            if (
              (operation as { operation: string }).operation ===
                "targets.list" &&
              truncated !== undefined
            )
              Object.assign(response.data as object, { truncated });
            return response;
          },
        });
        const inventory = await service.inventory(scope);
        expect(inventory.targets).toHaveLength(2);
        if (truncated === undefined)
          expect(inventory).not.toHaveProperty("truncated");
        else expect(inventory.truncated).toBe(truncated);
        expect(await service.targets(scope)).toEqual(inventory.targets);
        expect(launch).toHaveBeenCalledTimes(1);
      },
    );
    it("accepts actual PNG bytes with a downscaled, then resized logical target without changing its generation", async () => {
      let logicalWidth = 800;
      const { service, launch } = create({
        transform: (operation, response) => {
          if (
            (operation as { operation: string }).operation ===
            "observation.snapshot"
          ) {
            const data = response.data as CuaSnapshot;
            // Only native geometry is simulated. The pixels, dimensions and
            // digest remain the real fake helper's valid 320x200 PNG.
            const target = data.session.target!;
            target.bounds = {
              x: -500,
              y: 25,
              width: logicalWidth,
              height: logicalWidth * 0.625,
            };
            target.pixelWidth = data.image.width;
            target.pixelHeight = data.image.height;
            target.scaleFactor = data.image.width / logicalWidth;
          }
          return response;
        },
      });
      const { binding } = await service.open(scope, windowTarget);
      const id = binding.sessionId;
      await service.move(scope, id, windowTarget, { x: 40, y: 25 });
      for (const width of [800, 400]) {
        logicalWidth = width;
        const captured = await service.snapshot(scope, id, windowTarget);
        expect(captured.image).toMatchObject({ width: 320, height: 200 });
        expect(captured.payload.readUInt32BE(16)).toBe(320);
        expect(captured.payload.readUInt32BE(20)).toBe(200);
        expect(captured.session.target).toMatchObject({
          id: windowTarget.targetId,
          generation: 1,
          bounds: { x: -500, y: 25, width, height: width * 0.625 },
          pixelWidth: 320,
          pixelHeight: 200,
          scaleFactor: 320 / width,
        });
        expect(captured.session.cursor.position).toEqual({ x: 40, y: 25 });
        expect(service.state(scope, id)).toEqual(captured.session);
        captured.payload.fill(0);
      }
      expect(service.status().sessions).toBe(1);
      expect(launch).toHaveBeenCalledTimes(1);
    });
    it("does not cache an inventory permission denial or relaunch after an explicit retry", async () => {
      let denied = true;
      const { service, launch, operations } = create({
        beforeRequest: (operation) => {
          if (
            denied &&
            (operation as { operation: string }).operation === "targets.list"
          )
            throw new CuaNativeError("permission-denied");
        },
      });
      await expect(service.inventory(scope)).rejects.toMatchObject({
        name: "CuaNativeError",
        code: "permission-denied",
      });
      expect(service.status()).toMatchObject({
        state: "running",
        sessions: 0,
        processGeneration: 1,
        lastFailure: null,
      });
      expect(operations).toHaveLength(2); // One handshake and one actual attempt.
      denied = false;
      expect((await service.inventory(scope)).targets).toHaveLength(2);
      expect(launch).toHaveBeenCalledTimes(1);
    });
    it.each(["permission-denied", "target-not-found", "stale-target"] as const)(
      "preserves authoritative %s without restarting, replacing the session, or retrying",
      async (code) => {
        let rejected = true;
        const { service, launch, operations } = create({
          beforeRequest: (operation) => {
            if (
              rejected &&
              (operation as { operation: string }).operation ===
                "observation.snapshot"
            )
              throw new CuaNativeError(code);
          },
        });
        const { binding } = await service.open(scope, windowTarget);
        const before = service.state(scope, binding.sessionId);
        await expect(
          service.snapshot(scope, binding.sessionId, windowTarget),
        ).rejects.toMatchObject({ name: "CuaNativeError", code });
        expect(service.state(scope, binding.sessionId)).toEqual(before);
        expect(service.status()).toMatchObject({
          state: "running",
          sessions: 1,
          processGeneration: 1,
          lastFailure: null,
        });
        expect(
          operations.filter(
            (operation) =>
              (operation as { operation: string }).operation ===
              "observation.snapshot",
          ),
        ).toHaveLength(1);
        rejected = false;
        const retryTarget =
          code === "permission-denied" ? windowTarget : monitor;
        // A closed/replaced window needs explicit selection of a current
        // target. Do not suggest that retrying its old generation revives it.
        if (code !== "permission-denied")
          await service.attach(scope, binding.sessionId, retryTarget);
        const retried = await service.snapshot(
          scope,
          binding.sessionId,
          retryTarget,
        );
        expect(retried.session.binding).toEqual(binding);
        expect(retried.session.target?.id).toBe(retryTarget.targetId);
        expect(retried.session.observationRevision).toBe(1);
        retried.payload.fill(0);
        expect(launch).toHaveBeenCalledTimes(1);
      },
    );
    it("shares one lazy handshake, configures all styles, returns binary snapshots, detaches and closes", async () => {
      const { service, launch, operations } = create();
      const [capabilities, targets] = await Promise.all([
        service.capabilities(scope),
        service.targets(scope),
      ]);
      expect(capabilities).toMatchObject({
        capture: true,
        backend: "fake",
        nativeInput: false,
      });
      expect(targets.map((target) => target.kind)).toEqual([
        "monitor",
        "window",
      ]);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(
        operations.filter(
          (operation) =>
            (operation as { operation: string }).operation ===
            "capabilities.get",
        ),
      ).toHaveLength(1);
      const session = await service.open(scope, monitor);
      const id = session.binding.sessionId;
      const digests = new Set<string>();
      for (const style of ["arrow", "dot", "ring", "crosshair"] as const) {
        const configured = await service.configure(scope, id, monitor, {
          ...appearance,
          style,
        });
        expect(configured.cursor.appearance.style).toBe(style);
        await service.move(scope, id, monitor, { x: 40, y: 25 });
        const snapshot = await service.snapshot(scope, id, monitor);
        expect(snapshot.image).toMatchObject({
          mediaType: "image/png",
          width: 640,
          height: 360,
          cursorIncluded: true,
        });
        expect(Buffer.isBuffer(snapshot.payload)).toBe(true);
        digests.add(snapshot.image.sha256);
      }
      expect(digests.size).toBe(4);
      const before = service.state(scope, id);
      const reattached = await service.attach(scope, id, monitor);
      expect(reattached.cursor).toEqual(before.cursor);
      // The caller cannot mutate cached authority/state through returned values.
      reattached.binding.workerId = "other";
      expect(service.state(scope, id).binding.workerId).toBe("worker");
      expect((await service.detach(scope, id)).target).toBeNull();
      await service.attach(scope, id, windowTarget);
      expect(
        (await service.snapshot(scope, id, windowTarget)).image.width,
      ).toBe(320);
      service.stopSession(scope, id);
      expect(() => service.state(scope, id)).toThrow(/no longer active/u);
      await service.close();
    });
    it("rejects each foreign ownership field and stale target without writing requests", async () => {
      const { service, operations } = create();
      const { binding } = await service.open(scope, monitor);
      for (const key of Object.keys(scope) as (keyof CuaScope)[]) {
        const count = operations.length;
        expect(() =>
          service.state({ ...scope, [key]: "foreign" }, binding.sessionId),
        ).toThrow(/another/u);
        expect(operations).toHaveLength(count);
      }
      const count = operations.length;
      await expect(
        service.snapshot(scope, binding.sessionId, windowTarget),
      ).rejects.toMatchObject({ code: "stale-target" });
      expect(operations).toHaveLength(count);
    });
    it("cancels only the interrupted chat and revokes all handles on terminal disconnect", async () => {
      const { service } = create();
      const first = await service.open(scope, monitor);
      const otherScope = { ...scope, chatId: "another-chat" };
      const other = await service.open(otherScope, windowTarget);
      service.cancelChat(scope.chatId, scope.threadId);
      expect(() => service.state(scope, first.binding.sessionId)).toThrow();
      expect(
        service.state(otherScope, other.binding.sessionId).target?.id,
      ).toBe("fake-window");
      service.disconnect();
      await expect(service.targets(scope)).rejects.toMatchObject({
        code: "disconnected",
      });
      service.reconnect();
      expect(() =>
        service.state(otherScope, other.binding.sessionId),
      ).toThrow();
      expect((await service.targets(scope)).length).toBe(2);
    });
    it("allows exactly one explicit crash restart and never revives or replays old sessions", async () => {
      const { service, children, launch } = create();
      const session = await service.open(scope, monitor);
      await crash(children[0]!);
      expect(service.status().state).toBe("restart-available");
      expect(() => service.state(scope, session.binding.sessionId)).toThrow();
      await service.targets(scope);
      expect(launch).toHaveBeenCalledTimes(2);
      expect(service.status().sessions).toBe(0);
      await crash(children[1]!);
      await expect(service.targets(scope)).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(launch).toHaveBeenCalledTimes(2);
    });
    it("detects corrupted image bytes and closes the malformed helper without restart", async () => {
      const { service } = create({
        transform: (operation, response) => {
          if (
            (operation as { operation: string }).operation ===
            "observation.snapshot"
          )
            response.payload[30] = response.payload[30]! ^ 1;
          return response;
        },
      });
      const session = await service.open(scope, monitor);
      await expect(
        service.snapshot(scope, session.binding.sessionId, monitor),
      ).rejects.toMatchObject({ code: "protocol-error" });
      expect(service.status().state).toBe("failed");
    });
    it("rejects a response bound to a different owner context", async () => {
      const { service } = create({
        transform: (operation, response) => {
          if (
            (operation as { operation: string }).operation === "target.attach"
          ) {
            (
              response.data as { session: { binding: { chatId: string } } }
            ).session.binding.chatId = "foreign";
          }
          return response;
        },
      });
      await expect(service.open(scope, monitor)).rejects.toMatchObject({
        code: "protocol-error",
      });
      expect(service.status().sessions).toBe(0);
    });
    it("does not launch for an already-cancelled operation", async () => {
      const { service, launch } = create();
      const controller = new AbortController();
      controller.abort();
      await expect(
        service.targets(scope, controller.signal),
      ).rejects.toMatchObject({ code: "cancelled", outcome: "not-sent" });
      expect(launch).not.toHaveBeenCalled();
    });
    it("cancels a handshake waiter immediately without cancelling another authorized waiter", async () => {
      const entered = deferred();
      const release = deferred();
      const { service, launch } = create({
        transform: async (operation, response) => {
          if (
            (operation as { operation: string }).operation ===
            "capabilities.get"
          ) {
            entered.resolve();
            await release.promise;
          }
          return response;
        },
      });
      const controller = new AbortController();
      const cancelled = service.capabilities(scope, controller.signal);
      const survivor = service.capabilities(scope);
      await entered.promise;
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({
        code: "cancelled",
        outcome: "not-sent",
      });
      release.resolve();
      expect((await survivor).capture).toBe(true);
      expect(launch).toHaveBeenCalledTimes(1);
    });
    it("settles queued cancellation without reordering other session work or sending the cancelled move", async () => {
      const entered = deferred();
      const release = deferred();
      let firstMove = true;
      const { service, operations } = create({
        transform: async (operation, response) => {
          if (
            (operation as { operation: string }).operation === "cursor.move" &&
            firstMove
          ) {
            firstMove = false;
            entered.resolve();
            await release.promise;
          }
          return response;
        },
      });
      const { binding } = await service.open(scope, monitor);
      const first = service.move(scope, binding.sessionId, monitor, {
        x: 1,
        y: 1,
      });
      await entered.promise;
      const controller = new AbortController();
      const cancelled = service.move(
        scope,
        binding.sessionId,
        monitor,
        { x: 2, y: 2 },
        controller.signal,
      );
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({
        code: "cancelled",
        outcome: "not-sent",
      });
      const last = service.move(scope, binding.sessionId, monitor, {
        x: 3,
        y: 3,
      });
      release.resolve();
      await first;
      expect((await last).cursor.position).toEqual({ x: 3, y: 3 });
      expect(
        operations.filter(
          (operation) =>
            (operation as { operation: string }).operation === "cursor.move",
        ),
      ).toHaveLength(2);
    });
    it("does not publish inventory when disconnect races a completed native response", async () => {
      const { service } = create({
        transform: (operation, response) => {
          if ((operation as { operation: string }).operation === "targets.list")
            service.disconnect();
          return response;
        },
      });
      await expect(service.targets(scope)).rejects.toMatchObject({
        code: "disconnected",
      });
    });
    it("does not publish a completed mutation after cancellation or resurrect its session", async () => {
      const controller = new AbortController();
      const { service } = create({
        transform: (operation, response) => {
          if ((operation as { operation: string }).operation === "cursor.move")
            controller.abort();
          return response;
        },
      });
      const { binding } = await service.open(scope, monitor);
      await expect(
        service.move(
          scope,
          binding.sessionId,
          monitor,
          { x: 1, y: 1 },
          controller.signal,
        ),
      ).rejects.toMatchObject({ code: "cancelled", outcome: "unknown" });
      expect(() => service.state(scope, binding.sessionId)).toThrow();
    });
  },
);
