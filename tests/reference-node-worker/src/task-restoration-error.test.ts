import { describe, expect, it } from "vitest";
import { protectedTaskRuntimeError } from "./task-operation.js";
import { TaskRestorationError } from "./task-restoration-error.js";

describe("Task restore diagnostics", () => {
  it("publishes the restoration stage and RPC code while retaining private causes locally", () => {
    const secret = "private Task text and /private/credential/path";
    const failure = new TaskRestorationError(
      "attach",
      new Error(secret),
      -32600,
    );
    const publicError = protectedTaskRuntimeError(failure, "operation");
    expect(publicError.message).toBe(
      "Task restoration failed at attach (native RPC code -32600).",
    );
    expect(publicError.cause).toBeUndefined();
    expect(publicError.stack).not.toContain(secret);
    expect(failure.cause).toBeInstanceOf(Error);
    expect(
      protectedTaskRuntimeError(new Error(secret), "operation").message,
    ).toBe("Encrypted Task operation failed.");
  });
});
