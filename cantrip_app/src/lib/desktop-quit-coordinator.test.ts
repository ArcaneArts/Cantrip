import { expect, it, vi } from "vitest";
import { DesktopQuitCoordinator } from "./desktop-quit-coordinator";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("freezes all editors and waits for actual writes, including inactive drafts", async () => {
  const coordinator = new DesktopQuitCoordinator();
  const writes = [deferred(), deferred()];
  const events: string[] = [];
  for (let index = 0; index < 2; index++)
    coordinator.register({
      suspend: () => {
        events.push(`freeze${index}`);
        return () => events.push(`resume${index}`);
      },
      checkpoint: () => {
        events.push(`write${index}`);
        return writes[index]!.promise;
      },
    });
  let finished = false;
  const pending = coordinator.prepare(1).then(() => {
    finished = true;
  });
  expect(events).toEqual(["freeze0", "freeze1", "write0", "write1"]);
  writes[0]!.resolve();
  await Promise.resolve();
  expect(finished).toBe(false);
  writes[1]!.resolve();
  await pending;
  expect(coordinator.preparing).toBe(true);
  coordinator.cancel(0);
  expect(coordinator.preparing).toBe(true);
  coordinator.cancel(1);
  expect(events.slice(-2)).toEqual(["resume1", "resume0"]);
});
it("retains live editors and allows retry after a real checkpoint failure", async () => {
  const coordinator = new DesktopQuitCoordinator();
  const resume = vi.fn();
  const checkpoint = vi
    .fn()
    .mockRejectedValueOnce(new Error("disk full"))
    .mockResolvedValue(undefined);
  coordinator.register({ suspend: () => resume, checkpoint });
  await expect(coordinator.prepare(1)).rejects.toThrow("disk full");
  expect(resume).toHaveBeenCalledOnce();
  expect(coordinator.preparing).toBe(false);
  await coordinator.prepare(2);
  expect(checkpoint).toHaveBeenCalledTimes(2);
  coordinator.cancel(2);
});
it.each(["register", "unregister", "cancel"])(
  "rejects %s during an outstanding write",
  async (action) => {
    const coordinator = new DesktopQuitCoordinator();
    const write = deferred();
    const resume = vi.fn();
    const unregister = coordinator.register({
      suspend: () => resume,
      checkpoint: () => write.promise,
    });
    const pending = coordinator.prepare(1);
    if (action === "register")
      coordinator.register({
        suspend: () => () => {},
        checkpoint: async () => {},
      });
    else if (action === "unregister") unregister();
    else coordinator.cancel(1);
    write.resolve();
    await expect(pending).rejects.toThrow("ownership changed");
    expect(resume).toHaveBeenCalledOnce();
  },
);
it("rolls back earlier suspensions if another editor is already transferring", async () => {
  const coordinator = new DesktopQuitCoordinator();
  const resume = vi.fn();
  const checkpoint = vi.fn();
  coordinator.register({ suspend: () => resume, checkpoint });
  coordinator.register({
    suspend: () => {
      throw new Error("transferring");
    },
    checkpoint,
  });
  await expect(coordinator.prepare(1)).rejects.toThrow("transferring");
  expect(resume).toHaveBeenCalledOnce();
  expect(checkpoint).not.toHaveBeenCalled();
});
it("resumes other editors even when one release throws", async () => {
  const coordinator = new DesktopQuitCoordinator();
  const resume = vi.fn();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  coordinator.register({ suspend: () => resume, checkpoint: async () => {} });
  coordinator.register({
    suspend: () => () => {
      throw new Error("renderer failed");
    },
    checkpoint: async () => {},
  });
  try {
    await coordinator.prepare(1);
    coordinator.cancel(1);
    expect(resume).toHaveBeenCalledOnce();
    expect(coordinator.preparing).toBe(false);
    expect(error).toHaveBeenCalledOnce();
  } finally {
    error.mockRestore();
  }
});
