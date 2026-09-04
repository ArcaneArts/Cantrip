import { describe, expect, it } from "vitest";

import { projectScriptCommandDestination } from "./project-script-command";

describe("project script command destination", () => {
  it("reuses the selected idle terminal", () => {
    expect(
      projectScriptCommandDestination({
        activeWorktreeId: "worktree-1",
        currentSurface: { paneId: "group-1", kind: "terminal" },
        selectedTerminal: { id: "terminal-1", status: "idle" },
      }),
    ).toEqual({ kind: "current-terminal", terminalId: "terminal-1" });
  });

  it("opens a sibling terminal when the selected terminal is busy", () => {
    expect(
      projectScriptCommandDestination({
        activeWorktreeId: "worktree-1",
        currentSurface: { paneId: "group-1", kind: "terminal" },
        selectedTerminal: { id: "terminal-1", status: "running" },
      }),
    ).toEqual({
      kind: "new-terminal",
      paneId: "group-1",
      worktreeId: "worktree-1",
    });
  });

  it("opens a sibling terminal from another project surface", () => {
    expect(
      projectScriptCommandDestination({
        activeWorktreeId: "worktree-2",
        currentSurface: { paneId: "group-2", kind: "chat" },
        selectedTerminal: null,
      }),
    ).toEqual({
      kind: "new-terminal",
      paneId: "group-2",
      worktreeId: "worktree-2",
    });
  });

  it("opens a sidebar terminal from the project overview", () => {
    expect(
      projectScriptCommandDestination({
        activeWorktreeId: null,
        currentSurface: null,
        selectedTerminal: null,
      }),
    ).toEqual({ kind: "new-terminal" });
  });
});
