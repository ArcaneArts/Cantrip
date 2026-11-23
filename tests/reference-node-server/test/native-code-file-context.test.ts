import { describe, expect, it, vi } from "vitest";
import { ProjectExecutionRepositoryFacade } from "../src/db/repository-facade-project-execution.js";

describe("native Code-tab file authority", () => {
  it("uses owned Code-tab metadata as a bound native file context without an editor runtime", async () => {
    const nativeContext = {
      codeTab: { projectId: "project" },
      cwd: "/worker/checkout",
      workerId: "worker",
      worktreeId: "checkout",
      capabilities: { available: false },
    };
    const code = vi.fn().mockResolvedValue(nativeContext);
    const resolve =
      ProjectExecutionRepositoryFacade.prototype.getExplorerExecutionContext.bind(
        {
          explorers: {
            getExplorerExecutionContext: vi.fn().mockResolvedValue(null),
          },
          codeSurfaces: { getCodeTabExecutionContext: code },
        } as never,
      );
    expect(await resolve("owner", "tab")).toEqual({
      explorerId: "tab",
      projectId: "project",
      root: "/worker/checkout",
      workerId: "worker",
      worktreeId: "checkout",
    });
    expect(code).toHaveBeenCalledWith("owner", "tab");
    code.mockResolvedValue(null);
    expect(await resolve("another-owner", "tab")).toBeNull();
  });
  it("preserves an owned Explorer context and does not reinterpret its id", async () => {
    const explorer = {
      explorerId: "explorer",
      projectId: "project",
      root: "/root",
      workerId: "worker",
      worktreeId: "checkout",
    };
    const code = vi.fn();
    const resolve =
      ProjectExecutionRepositoryFacade.prototype.getExplorerExecutionContext.bind(
        {
          explorers: {
            getExplorerExecutionContext: vi.fn().mockResolvedValue(explorer),
          },
          codeSurfaces: { getCodeTabExecutionContext: code },
        } as never,
      );
    expect(await resolve("owner", "explorer")).toBe(explorer);
    expect(code).not.toHaveBeenCalled();
  });
});
