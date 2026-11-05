import assert from "node:assert/strict";
import * as protocol from "../../packages/protocol/dist/index.js";
export const sourcePath = "/worker-owned/settings";
export const managedRoot = sourcePath + "/.worktrees";
export const agentTree = "mcp-agent-tree";
export const userTree = "mcp-user-tree";
export const operations = [
  "list",
  "status",
  "create",
  "acquire",
  "switch",
  "release",
  "remove",
].map((action) => "worktree." + action);
// Acquire belongs to the shared legacy CLI executor, not the MCP allowlist.
export const mcpOperations = operations.filter(
  (op) => op !== "worktree.acquire",
);
export const mutations = new Set(mcpOperations.slice(2));
const workerTree = (path, branch, primary = false) =>
  protocol.workerWorktreeSummarySchema.parse({
    path,
    branch,
    head: "a".repeat(40),
    detached: branch === null,
    isPrimary: primary,
    managed: !primary,
    locked: false,
    lockReason: null,
    prunable: false,
    pruneReason: null,
    missing: false,
  });
export function worktreeWorker() {
  const state = {
    entries: new Map([
      [sourcePath, workerTree(sourcePath, "main", true)],
      [managedRoot + "/agent", workerTree(managedRoot + "/agent", "feature-a")],
      [managedRoot + "/user", workerTree(managedRoot + "/user", "feature-u")],
    ]),
    commands: [],
    housekeeping: [],
    mode: null,
    files: [],
    branch: undefined,
  };
  state.inventory = () =>
    protocol.worktreeInventorySchema.parse({
      sourcePath,
      primaryPath: sourcePath,
      managedRoot,
      gitCommonDir: sourcePath + "/.git",
      repositoryFingerprint: "a".repeat(64),
      worktrees: [...state.entries.values()],
    });
  state.onCommand = async (command) => {
    if (command.type === "worktree.observation.configure")
      return { accepted: true, paths: command.paths };
    if (command.type === "worktree.reconcile") {
      state.housekeeping.push(structuredClone(command));
      return state.inventory();
    }
    if (
      !["worktree.status", "worktree.create", "worktree.remove"].includes(
        command.type,
      )
    )
      return;
    state.commands.push(structuredClone(command));
    await state.beforeCommand?.(command);
    if (command.type === "worktree.create") {
      state.lastCreatedId = command.worktreeId;
      if (state.mode === "create-failure")
        throw new Error("Controlled worktree creation failure");
      const path = managedRoot + "/" + command.worktreeId;
      const tree = workerTree(
        path,
        command.mode.type === "detached" ? null : command.mode.branch,
      );
      state.entries.set(path, tree);
      return { created: true, worktree: tree, inventory: state.inventory() };
    }
    const tree = state.entries.get(command.worktreePath);
    assert.ok(tree, "The server dispatches an actual controlled worker path");
    if (command.type === "worktree.remove") {
      assert.equal(command.force, false);
      assert.equal(command.allowExternal, false);
      state.entries.delete(command.worktreePath);
      return {
        removedPath: command.worktreePath,
        inventory: state.inventory(),
      };
    }
    if (state.mode === "invalid-status") return {};
    const status = protocol.worktreeStatusResultSchema.parse({
      worktree: {
        ...tree,
        ...(state.mode === "wrong-path" ? { path: tree.path + "/wrong" } : {}),
      },
      status: {
        branch: state.branch ?? tree.branch ?? "",
        head: tree.head,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: state.files,
        branches: ["main", "feature-a", "feature-u"].map((name, index) => ({
          name,
          kind: "local",
          current: index === 0,
          hash: "a".repeat(40),
          upstream: null,
        })),
      },
    });
    return status;
  };
  return state;
}
