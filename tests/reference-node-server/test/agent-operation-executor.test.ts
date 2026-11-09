import { describe, expect, it, vi } from "vitest";

import { createCantripAgentOperationExecutor } from "../src/agent-tools/executor.js";

describe("Cantrip agent operation executor", () => {
  it("validates a transport-neutral request and normalizes its result", async () => {
    const handler = vi.fn(async () => ({ summary: "Found the context." }));
    const executor = createCantripAgentOperationExecutor(handler);

    await expect(
      executor.execute(
        { projectId: "project-one" },
        { operation: "context.get", arguments: {} },
      ),
    ).resolves.toEqual({
      summary: "Found the context.",
      target: null,
      worktreeId: null,
      continuationScheduled: false,
      mutated: false,
    });
    expect(handler).toHaveBeenCalledWith(
      { projectId: "project-one" },
      { operation: "context.get", arguments: {} },
    );
  });

  it("rejects unknown operations before dispatch", async () => {
    const handler = vi.fn();
    const executor = createCantripAgentOperationExecutor(handler);

    await expect(
      executor.execute({ projectId: "project-one" }, {
        operation: "shell.run",
        arguments: {},
      } as never),
    ).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects unbounded argument maps and invalid results", async () => {
    const executor = createCantripAgentOperationExecutor(async () => ({
      summary: "",
    }));
    const arguments_ = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`argument-${index}`, index]),
    );

    await expect(
      executor.execute(
        { projectId: "project-one" },
        { operation: "target.list", arguments: arguments_ },
      ),
    ).rejects.toThrow("at most 32 arguments");
    await expect(
      executor.execute(
        { projectId: "project-one" },
        { operation: "target.list", arguments: {} },
      ),
    ).rejects.toThrow();
  });
});
