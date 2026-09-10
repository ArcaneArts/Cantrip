import { describe, expect, it } from "vitest";
import { ManagedRuntimeHandoffStaging } from "../src/codex/managed-runtime-handoff-staging.js";

describe("handoff autonomous execution hold", () => {
  it("holds only the transferring thread until its own publication", async () => {
    const staging = new ManagedRuntimeHandoffStaging();
    const runtime = {};
    staging.hold(runtime, "thread", "operation");
    let released = false;
    const wait = staging
      .wait(runtime, "thread", new AbortController().signal)
      .then(() => {
        released = true;
      });
    await staging.wait(runtime, "other-thread", new AbortController().signal);
    expect(released).toBe(false);
    expect(() => staging.release(runtime, "thread", "other-operation")).toThrow(
      "Another handoff",
    );
    staging.release(runtime, "thread", "operation");
    await wait;
    expect(released).toBe(true);
    expect(staging.held(runtime, "thread")).toBe(false);
  });
  it("honors explicit cancellation and never releases retired source attempts", async () => {
    const staging = new ManagedRuntimeHandoffStaging();
    const runtime = {};
    staging.hold(runtime, "thread", "operation");
    const abort = new AbortController();
    const cancelled = staging.wait(runtime, "thread", abort.signal);
    abort.abort(new Error("explicit stop"));
    await expect(cancelled).rejects.toThrow("explicit stop");
    expect(staging.held(runtime, "thread")).toBe(true);
    const waiting = staging.wait(
      runtime,
      "thread",
      new AbortController().signal,
    );
    staging.retire(runtime, "thread", "operation");
    await expect(waiting).rejects.toThrow("retired");
    expect(() => staging.release(runtime, "thread", "operation")).toThrow(
      "retired",
    );
    await expect(
      staging.wait(runtime, "thread", new AbortController().signal),
    ).rejects.toThrow("retired");
  });
});
