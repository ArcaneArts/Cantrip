import type { ProjectWorktreeSummary } from "@cantrip/protocol";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  resolve: vi.fn(),
  status: vi.fn(),
}));

vi.mock("./projects", () => ({ getProjectWorktreeWireList: mocks.list }));
vi.mock("./worker-wire", () => ({ getWorkers: async () => [] }));
vi.mock("./repository-identity", () => ({
  resolveWorkerRepositoryMetadata: mocks.resolve,
}));
vi.mock("./repository-operations", () => ({
  getProtectedWorktreeStatus: mocks.status,
}));

import { getProjectWorktrees } from "./worktrees";

const handle = `ctrr_${"x".repeat(43)}`;
const path = "/tmp/worktrees/marginalia-polish-a1b2c3";
const date = "2026-11-26T00:00:00Z";
const worktree: ProjectWorktreeSummary = {
  id: "worktree",
  projectId: "project",
  projectSourceId: "source",
  rootKind: "git-worktree",
  workerId: "worker",
  name: handle,
  path: handle,
  displayPath: handle,
  isPrimary: false,
  isDefault: false,
  origin: "cantrip",
  lifecycleState: "ready",
  branch: handle,
  head: null,
  detached: false,
  locked: false,
  lockReason: null,
  lastScannedAt: null,
  createdAt: date,
  updatedAt: date,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue([worktree]);
  mocks.status.mockResolvedValue({
    worktree: { ...worktree, path, branch: "codex/marginalia-polish" },
  });
});

it("shows the selected name instead of the generated directory basename", async () => {
  mocks.resolve.mockResolvedValue({ values: { name: "Marginalia polish" } });
  await expect(getProjectWorktrees("project")).resolves.toMatchObject([
    { name: "Marginalia polish", path, branch: "codex/marginalia-polish" },
  ]);
  expect(mocks.resolve).toHaveBeenCalledWith({
    workerId: "worker",
    scopeId: "project",
    values: { name: handle },
  });
});

it("preserves the usable checkout when the worker cannot resolve the name", async () => {
  mocks.resolve.mockRejectedValue(new Error("Unknown name"));
  await expect(getProjectWorktrees("project")).resolves.toMatchObject([
    { name: "marginalia-polish-a1b2c3", path },
  ]);
});

it("preserves existing plain labels without a metadata lookup", async () => {
  mocks.list.mockResolvedValue([{ ...worktree, name: "Release notes" }]);
  await expect(getProjectWorktrees("project")).resolves.toMatchObject([
    { name: "Release notes", path },
  ]);
  expect(mocks.resolve).not.toHaveBeenCalled();
});
