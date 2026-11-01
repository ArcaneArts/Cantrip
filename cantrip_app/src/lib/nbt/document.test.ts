import { afterEach, expect, it, vi } from "vitest";
import { JAVA_NBT } from "@cantrip/nbt";
import { openNbtDocument } from "./document";
afterEach(() => vi.unstubAllGlobals());
it("rejects a worker startup failure and releases the remote binary source", async () => {
  const terminate = vi.fn(),
    close = vi.fn();
  class BrokenWorker {
    private listeners = new Map<string, Set<(event: unknown) => void>>();
    addEventListener(type: string, listener: (event: unknown) => void) {
      const group = this.listeners.get(type) ?? new Set();
      group.add(listener);
      this.listeners.set(type, group);
    }
    removeEventListener(type: string, listener: (event: unknown) => void) {
      this.listeners.get(type)?.delete(listener);
    }
    postMessage() {
      queueMicrotask(() => {
        for (const listener of this.listeners.get("error") ?? [])
          listener({ preventDefault() {} });
      });
    }
    terminate = terminate;
  }
  vi.stubGlobal("Worker", BrokenWorker);
  await expect(
    openNbtDocument(
      { size: 1, read: vi.fn(), close },
      { binding: "account/document/revision", format: JAVA_NBT },
    ),
  ).rejects.toThrow("worker stopped");
  expect(terminate).toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});
it("releases the source when the worker constructor itself fails", async () => {
  const close = vi.fn();
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        throw new DOMException("Workers are blocked.", "SecurityError");
      }
    },
  );
  await expect(
    openNbtDocument(
      { size: 1, read: vi.fn(), close },
      { binding: "account/document/revision", format: JAVA_NBT },
    ),
  ).rejects.toThrow("Workers are blocked");
  expect(close).toHaveBeenCalledOnce();
});
