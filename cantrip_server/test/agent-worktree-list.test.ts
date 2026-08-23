import { describe, expect, it } from "vitest";

import { visibleWorktreeLeases } from "../src/agent-tools/worktree-list.js";

describe("agent worktree listing", () => {
  const worktrees = [
    { id: "primary", isPrimary: true },
    { id: "secondary", isPrimary: false },
  ];
  const leases = [
    { id: "active-primary", worktreeId: "primary", state: "active" as const },
    {
      id: "idle-primary",
      worktreeId: "primary",
      state: "suspended" as const,
    },
    {
      id: "resumable-secondary",
      worktreeId: "secondary",
      state: "suspended" as const,
    },
    {
      id: "released-secondary",
      worktreeId: "secondary",
      state: "released" as const,
    },
  ];

  it("keeps only leases that still protect work by default", () => {
    expect(visibleWorktreeLeases(worktrees, leases, false)).toEqual([
      leases[0],
      leases[2],
    ]);
  });

  it("returns released and idle Primary lanes for explicit history inspection", () => {
    expect(visibleWorktreeLeases(worktrees, leases, true)).toEqual(leases);
  });
});
