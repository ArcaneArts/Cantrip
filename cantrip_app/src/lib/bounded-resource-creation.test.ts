import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BoundedResourceOperationTimeoutError,
  createBoundedResource,
} from "./bounded-resource-creation";

describe("bounded resource creation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("compensates for a creation that never settles", async () => {
    vi.useFakeTimers();
    const rollback = vi.fn().mockResolvedValue(undefined);
    const creation = createBoundedResource({
      create: () => new Promise<never>(() => undefined),
      createTimeoutMs: 100,
      resourceId: "resource-1",
      rollback,
      rollbackTimeoutMs: 50,
    });
    const rejected = expect(creation).rejects.toBeInstanceOf(
      BoundedResourceOperationTimeoutError,
    );

    await vi.advanceTimersByTimeAsync(100);

    await rejected;
    expect(rollback).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledWith(
      "resource-1",
      expect.objectContaining({ aborted: false }),
    );
  });

  it("does not let a non-settling compensation wedge the caller", async () => {
    vi.useFakeTimers();
    const failure = new Error("create failed");
    const creation = createBoundedResource({
      create: () => Promise.reject(failure),
      createTimeoutMs: 100,
      resourceId: "resource-2",
      rollback: () => new Promise<never>(() => undefined),
      rollbackTimeoutMs: 50,
    });
    const rejected = expect(creation).rejects.toBe(failure);

    await vi.advanceTimersByTimeAsync(50);

    await rejected;
  });

  it("does not compensate for a successful creation", async () => {
    const rollback = vi.fn();

    await expect(
      createBoundedResource({
        create: () => Promise.resolve("ready"),
        createTimeoutMs: 100,
        resourceId: "resource-3",
        rollback,
        rollbackTimeoutMs: 50,
      }),
    ).resolves.toBe("ready");
    expect(rollback).not.toHaveBeenCalled();
  });
});
