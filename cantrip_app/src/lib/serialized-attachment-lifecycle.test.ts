import { describe, expect, it, vi } from "vitest";

import {
  retireAttachmentBestEffort,
  SerializedAttachmentLifecycle,
} from "./serialized-attachment-lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("SerializedAttachmentLifecycle", () => {
  it("releases the server attachment once when local stop rejects", async () => {
    const order: string[] = [];
    const stopLocal = vi.fn(async () => {
      order.push("stop-local");
      throw new Error("native stop failed");
    });
    const releaseServer = vi.fn(async () => {
      order.push("release-server");
    });

    await expect(
      retireAttachmentBestEffort(stopLocal, releaseServer),
    ).resolves.toBeUndefined();

    expect(stopLocal).toHaveBeenCalledOnce();
    expect(releaseServer).toHaveBeenCalledOnce();
    expect(order).toEqual(["stop-local", "release-server"]);
  });

  it("retires a late creation before starting its replacement", async () => {
    const firstCreate = deferred<{ id: string }>();
    const firstRetirement = deferred<void>();
    const order: string[] = [];
    const lifecycle = new SerializedAttachmentLifecycle<{ id: string }>(
      async (owned) => {
        order.push(`retire-${owned.id}-started`);
        await firstRetirement.promise;
        order.push(`retire-${owned.id}-finished`);
      },
    );

    const first = lifecycle.replace(
      async () => {
        order.push("create-first");
        return firstCreate.promise;
      },
      async () => {
        order.push("prepare-first");
        return "first";
      },
    );
    await vi.waitFor(() => expect(order).toEqual(["create-first"]));

    const second = lifecycle.replace(
      async () => {
        order.push("create-second");
        return { id: "second" };
      },
      async () => {
        order.push("prepare-second");
        return "second";
      },
    );
    firstCreate.resolve({ id: "first" });

    await vi.waitFor(() =>
      expect(order).toEqual(["create-first", "retire-first-started"]),
    );
    firstRetirement.resolve();
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBe("second");
    expect(order).toEqual([
      "create-first",
      "retire-first-started",
      "retire-first-finished",
      "create-second",
      "prepare-second",
    ]);
  });

  it("retires an attachment exactly once across repeated retirement", async () => {
    const retire = vi.fn(async () => undefined);
    const lifecycle = new SerializedAttachmentLifecycle(retire);
    await lifecycle.replace(
      async () => ({ id: "owned" }),
      async (owned) => owned,
    );

    await Promise.all([
      lifecycle.retire("first retirement"),
      lifecycle.retire("repeated retirement"),
    ]);

    expect(retire).toHaveBeenCalledOnce();
    expect(retire).toHaveBeenCalledWith({ id: "owned" });
  });

  it("waits for a pending creation and retirement before resolving stop", async () => {
    const creation = deferred<{ id: string }>();
    const retirement = deferred<void>();
    const order: string[] = [];
    const lifecycle = new SerializedAttachmentLifecycle<{ id: string }>(
      async () => {
        order.push("retire-started");
        await retirement.promise;
        order.push("retire-finished");
      },
    );
    const connection = lifecycle.replace(
      () => {
        order.push("create-started");
        return creation.promise;
      },
      async () => {
        order.push("prepared");
        return true;
      },
    );

    await vi.waitFor(() => expect(order).toEqual(["create-started"]));
    const stopped = lifecycle.retire().then(() => order.push("stop-code-tab"));
    creation.resolve({ id: "late" });
    await vi.waitFor(() =>
      expect(order).toEqual(["create-started", "retire-started"]),
    );
    retirement.resolve();
    await stopped;
    await expect(connection).resolves.toBeNull();

    expect(order).toEqual([
      "create-started",
      "retire-started",
      "retire-finished",
      "stop-code-tab",
    ]);
  });

  it("aborts preparation immediately and releases its ownership", async () => {
    const preparationStarted = deferred<void>();
    const prepared = deferred<void>();
    const retire = vi.fn(async () => undefined);
    const lifecycle = new SerializedAttachmentLifecycle(retire);
    const connection = lifecycle.replace(
      async () => ({ id: "owned" }),
      async (_owned, signal) => {
        preparationStarted.resolve();
        signal.addEventListener("abort", () => prepared.resolve(), {
          once: true,
        });
        await prepared.promise;
        signal.throwIfAborted();
        return true;
      },
    );
    await preparationStarted.promise;

    const stopped = lifecycle.retire();
    await prepared.promise;
    await expect(connection).resolves.toBeNull();
    await stopped;
    expect(retire).toHaveBeenCalledOnce();
  });

  it("allows a replacement after a failed retirement", async () => {
    const retired: string[] = [];
    const lifecycle = new SerializedAttachmentLifecycle<{ id: string }>(
      async (owned) => {
        retired.push(owned.id);
        throw new Error("retirement failed");
      },
    );
    await lifecycle.replace(
      async () => ({ id: "first" }),
      async () => "first",
    );

    await expect(lifecycle.retire()).rejects.toThrow("retirement failed");
    await expect(
      lifecycle.replace(
        async () => ({ id: "second" }),
        async () => "second",
      ),
    ).resolves.toBe("second");
    expect(retired).toEqual(["first"]);
  });
});
