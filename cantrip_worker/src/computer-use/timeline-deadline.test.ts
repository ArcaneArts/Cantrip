import { expect, it, vi } from "vitest";
import { CantripCuaService } from "./service.js";
import { CuaProcessError } from "./errors.js";
import {
  CUA_REQUIRED_OPERATIONS,
  cuaInputCommandSchema,
  type CuaScope,
  type CuaSession,
} from "./types.js";
import type { CuaRequestOptions } from "./transport.js";

it.each(
  [false, true].flatMap((stop) =>
    [30_000, 150_000, 86_400_000].map((durationMs) => ({ stop, durationMs })),
  ),
)(
  "planned playback runs for $durationMs ms with explicit Stop=$stop",
  async ({ stop, durationMs }) => {
    vi.useFakeTimers();
    const scope: CuaScope = {
      serverId: "server",
      ownerId: "owner",
      workerId: "worker",
      chatId: "chat",
      taskId: null,
      threadId: "thread",
      turnId: "turn",
    };
    const target = {
      id: "window",
      generation: 1,
      kind: "window",
      title: "Fixture",
      application: "Fixture",
      processId: 1,
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      pixelWidth: 100,
      pixelHeight: 100,
      scaleFactor: 1,
      focused: false,
      minimized: false,
    };
    let session: CuaSession;
    let entered = false;
    const service = new CantripCuaService({
      workerId: "worker",
      launch: () => ({
        closed: false,
        close: async () => {},
        request: async (raw: unknown, opts: CuaRequestOptions = {}) => {
          const input = raw as {
            operation: string;
            binding: CuaSession["binding"];
          };
          let data: unknown;
          if (input.operation === "capabilities.get")
            data = {
              protocolVersion: 1,
              runtimeVersion: "1",
              backend: "fake",
              capture: true,
              nativeInput: true,
              javascript: true,
              cursorAppearanceVersion: 1,
              operations: [...CUA_REQUIRED_OPERATIONS, "input.perform"],
              maxSessions: 16,
              maxImageBytes: 16777216,
            };
          else if (input.operation === "target.attach") {
            session = {
              binding: input.binding,
              target: target as CuaSession["target"],
              cursor: {
                appearance: {
                  version: 1,
                  style: "ring",
                  color: "#20BFA9",
                  size: 24,
                  label: "Agent",
                  trail: false,
                  visible: true,
                },
                position: { x: 1, y: 1 },
                trailPoints: [],
                updatedAtMs: 0,
                revision: 1,
              },
              observationRevision: 0,
            };
            data = { session };
          } else if (input.operation === "input.perform") {
            entered = true;
            await new Promise<void>((resolve, reject) => {
              const complete = setTimeout(() => finish(), durationMs);
              const timeout =
                opts.timeoutMs === 0
                  ? undefined
                  : setTimeout(
                      () => finish(new CuaProcessError("timeout")),
                      opts.timeoutMs,
                    );
              const abort = () => finish(new CuaProcessError("cancelled"));
              function finish(error?: Error) {
                clearTimeout(complete);
                clearTimeout(timeout);
                opts.signal?.removeEventListener("abort", abort);
                if (error) reject(error);
                else resolve();
              }
              opts.signal?.addEventListener("abort", abort, { once: true });
            });
            data = {
              session,
              input: {
                method: "background-timeline",
                activation: true,
                outcome: "unknown",
                windowDelivery: "unverified",
                position: { x: 1, y: 1 },
                globalPosition: { x: 1, y: 1 },
              },
            };
          } else data = { closed: true };
          return { data, payload: Buffer.alloc(0) };
        },
      }),
    });
    try {
      const opened = await service.open(scope, {
        targetId: "window",
        targetGeneration: 1,
      });
      const controller = new AbortController();
      let settled = false;
      const result = service
        .perform(
          scope,
          opened.binding.sessionId,
          { targetId: "window", targetGeneration: 1 },
          cuaInputCommandSchema.parse({
            kind: "timeline",
            frames: [
              { atMs: 0, pointerDown: { x: 1, y: 1 } },
              { atMs: 23108, pointerUp: true },
            ],
          }),
          controller.signal,
        )
        .then(
          (value) => {
            settled = true;
            return value;
          },
          (error) => {
            settled = true;
            return error;
          },
        );
      await vi.advanceTimersByTimeAsync(durationMs - 1_800);
      expect(entered).toBe(true);
      expect(settled).toBe(false);
      if (stop) controller.abort();
      else await vi.advanceTimersByTimeAsync(1_800);
      expect(await result).toMatchObject(
        stop
          ? { code: "cancelled" }
          : { input: { method: "background-timeline" } },
      );
    } finally {
      await service.close();
      vi.useRealTimers();
    }
  },
);
