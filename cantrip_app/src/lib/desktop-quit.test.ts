// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopQuitCoordinator } from "./desktop-quit-coordinator";
import { installDesktopQuit } from "./desktop-quit";
const io = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  handlers: new Map<string, (event: { payload: number }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: io.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (
    name: string,
    handler: (event: { payload: number }) => void,
  ) => {
    io.handlers.set(name, handler);
    return () => io.handlers.delete(name);
  },
}));
let unregister: (() => void) | undefined;
beforeEach(() => {
  document.body.inert = false;
});
afterEach(() => {
  io.handlers.get("cantrip-quit-cancel")?.({ payload: 1 });
  unregister?.();
  unregister = undefined;
  io.invoke.mockClear();
  io.handlers.clear();
  document.body.inert = false;
});
it("acknowledges only after the pending write and restores interaction on cancellation", async () => {
  let finish!: () => void;
  const write = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const resume = vi.fn();
  unregister = desktopQuitCoordinator.register({
    suspend: () => resume,
    checkpoint: () => write,
  });
  await installDesktopQuit();
  io.handlers.get("cantrip-quit-prepare")!({ payload: 1 });
  expect(document.body.inert).toBe(true);
  expect(io.invoke.mock.calls.map((call) => call[0])).toEqual([
    "register_desktop_quit",
  ]);
  finish();
  await vi.waitFor(() =>
    expect(io.invoke).toHaveBeenCalledWith(
      "acknowledge_desktop_quit",
      expect.objectContaining({ id: 1, ok: true }),
    ),
  );
  expect(resume).not.toHaveBeenCalled();
  io.handlers.get("cantrip-quit-cancel")!({ payload: 1 });
  expect(document.body.inert).toBe(false);
  expect(resume).toHaveBeenCalledOnce();
});
it("does not acknowledge success after a native timeout cancels preparation", async () => {
  let finish!: () => void;
  const write = new Promise<void>((resolve) => {
    finish = resolve;
  });
  unregister = desktopQuitCoordinator.register({
    suspend: () => () => {},
    checkpoint: () => write,
  });
  await installDesktopQuit();
  io.handlers.get("cantrip-quit-prepare")!({ payload: 1 });
  io.handlers.get("cantrip-quit-cancel")!({ payload: 1 });
  finish();
  await vi.waitFor(() =>
    expect(io.invoke).toHaveBeenCalledWith(
      "acknowledge_desktop_quit",
      expect.objectContaining({ ok: false }),
    ),
  );
  expect(io.invoke).not.toHaveBeenCalledWith(
    "acknowledge_desktop_quit",
    expect.objectContaining({ ok: true }),
  );
  expect(document.body.inert).toBe(false);
});
it("revokes a prepared acknowledgement if an editor unmounts before native exit", async () => {
  unregister = desktopQuitCoordinator.register({
    suspend: () => () => {},
    checkpoint: async () => {},
  });
  await installDesktopQuit();
  io.handlers.get("cantrip-quit-prepare")!({ payload: 1 });
  await vi.waitFor(() =>
    expect(io.invoke).toHaveBeenCalledWith(
      "acknowledge_desktop_quit",
      expect.objectContaining({ ok: true }),
    ),
  );
  unregister();
  expect(io.invoke).toHaveBeenLastCalledWith(
    "acknowledge_desktop_quit",
    expect.objectContaining({ ok: false }),
  );
});
