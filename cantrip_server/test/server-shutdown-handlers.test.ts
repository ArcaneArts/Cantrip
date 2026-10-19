import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installServerShutdownHandlers } from "../src/server-shutdown.js";

const { flush, event } = vi.hoisted(() => ({
  flush: vi.fn<() => Promise<void>>(),
  event: vi.fn(),
}));
vi.mock("../src/logger.js", () => ({
  closeServerLogArchive: flush,
  serverLogger: { event },
}));

const originalExitCode = process.exitCode;
beforeEach(() => {
  vi.resetAllMocks();
  flush.mockResolvedValue();
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

function install(close: () => Promise<undefined>) {
  const signals = new Map<string | symbol, () => void>();
  const once = vi
    .spyOn(process, "once")
    .mockImplementation((signal, listener) => {
      signals.set(signal, listener);
      return process;
    });
  try {
    installServerShutdownHandlers({ close });
  } finally {
    once.mockRestore();
  }
  return (signal: "SIGINT" | "SIGTERM") => signals.get(signal)!();
}

it("awaits cleanup and flushes once when both shutdown signals arrive", async () => {
  let finish!: () => void;
  const pending = new Promise<undefined>((resolve) => {
    finish = () => resolve(undefined);
  });
  const close = vi.fn(() => pending);
  const signal = install(close);
  signal("SIGTERM");
  signal("SIGINT");
  expect(close).toHaveBeenCalledTimes(1);
  expect(flush).not.toHaveBeenCalled();
  finish();
  await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
  expect(event).toHaveBeenCalledWith(
    "info",
    expect.any(String),
    expect.objectContaining({
      event: "server.shutdown.completed",
    }),
  );
  expect(process.exitCode).toBeUndefined();
});

it("reports the original cleanup error before flushing and preserves failure status", async () => {
  const error = new AggregateError(
    [new Error("worker offline")],
    "unacknowledged revocation",
  );
  install(async () => {
    throw error;
  })("SIGINT");
  await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
  expect(event).toHaveBeenCalledWith(
    "error",
    expect.any(String),
    expect.objectContaining({
      event: "server.shutdown.failed",
      reasonCode: "cleanup-failed",
      error,
    }),
  );
  const failedIndex = event.mock.calls.findIndex(
    (call) => call[2].event === "server.shutdown.failed",
  );
  expect(event.mock.invocationCallOrder[failedIndex]).toBeLessThan(
    flush.mock.invocationCallOrder[0]!,
  );
  expect(process.exitCode).toBe(1);
  expect(
    event.mock.calls.some(
      (call) => call[2].event === "server.shutdown.completed",
    ),
  ).toBe(false);
});

it("observes a rejected log flush without an unhandled signal promise", async () => {
  const error = new Error("archive close failed");
  flush.mockRejectedValue(error);
  install(async () => undefined)("SIGTERM");
  await vi.waitFor(() =>
    expect(event).toHaveBeenCalledWith(
      "error",
      expect.any(String),
      expect.objectContaining({
        event: "server.shutdown.failed",
        reasonCode: "shutdown-finalization-error",
        error,
      }),
    ),
  );
  expect(process.exitCode).toBe(1);
});
