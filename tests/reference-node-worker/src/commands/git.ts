import { readGitChangeSummary } from "../git-change-summary.js";
import {
  readGitHistory,
  readGitCommitDetail,
  readGitFileHistory,
  readGitFileBlame,
  searchGitCommits,
  readGitRecoveryCandidates,
  previewGitRecoveryAction,
  applyGitRecoveryAction,
  readGitCommitSignature,
  readGitRevisionCandidates,
  readGitComparison,
  readGitRevisionFileDiff,
  readGitStatus,
  readGitFileDiff,
  previewGitPartialPatch,
  applyGitPartialPatch,
  readGitStashes,
  createGitStash,
  readGitStashFileDiff,
  previewGitStashAction,
  applyGitStashAction,
  previewGitWorktreeChangesMove,
  applyGitWorktreeChangesMove,
  readGitBranches,
  previewGitBranchAction,
  applyGitBranchAction,
  readGitRemotes,
  previewGitRemoteAction,
  applyGitRemoteAction,
  readGitSubmodules,
  previewGitSubmoduleAction,
  applyGitSubmoduleAction,
  readGitLfsStatus,
  previewGitLfsAction,
  applyGitLfsAction,
  readGitTags,
  readGitTagDetail,
  previewGitTagAction,
  applyGitTagAction,
  previewGitCommitAction,
  applyGitCommitAction,
  previewGitManagedOperation,
  startGitManagedOperation,
  inspectGitManagedOperation,
  controlGitManagedOperation,
  amendGitManagedOperation,
  listGitConflicts,
  readGitConflict,
  previewGitConflictResolution,
  applyGitConflictResolution,
  runGitAction,
  previewGitForcePush,
  applyGitForcePush,
} from "../git.js";
import {
  readGitGraphSnapshot,
  readGitGraphMetrics,
  createGitGraphCommitOverlay,
} from "../git-graph.js";
import type { WorkerCommand } from "@cantrip/protocol";

export type GitCommand = Extract<
  WorkerCommand,
  {
    type:
      | "git.history"
      | "git.change-summary"
      | "git.graph.snapshot"
      | "git.graph.metrics"
      | "git.graph.commit-overlay"
      | "git.file.history"
      | "git.file.blame"
      | "git.commit.search"
      | "git.recovery.list"
      | "git.recovery.preview"
      | "git.recovery.apply"
      | "git.commit.get"
      | "git.commit.signature.get"
      | "git.refs.list"
      | "git.compare"
      | "git.revision.diff"
      | "git.status"
      | "git.diff"
      | "git.patch.preview"
      | "git.patch.apply"
      | "git.stash.list"
      | "git.stash.create"
      | "git.stash.diff"
      | "git.stash.action.preview"
      | "git.stash.action.apply"
      | "git.worktree.changes.preview"
      | "git.worktree.changes.apply"
      | "git.branch.list"
      | "git.branch.action.preview"
      | "git.branch.action.apply"
      | "git.remote.list"
      | "git.remote.action.preview"
      | "git.remote.action.apply"
      | "git.submodule.list"
      | "git.submodule.action.preview"
      | "git.submodule.action.apply"
      | "git.lfs.status"
      | "git.lfs.action.preview"
      | "git.lfs.action.apply"
      | "git.tag.list"
      | "git.tag.get"
      | "git.tag.action.preview"
      | "git.tag.action.apply"
      | "git.commit.action.preview"
      | "git.commit.action.apply"
      | "git.operation.preview"
      | "git.operation.start"
      | "git.operation.inspect"
      | "git.operation.control"
      | "git.operation.amend"
      | "git.conflicts.list"
      | "git.conflicts.get"
      | "git.conflicts.preview"
      | "git.conflicts.apply"
      | "git.action"
      | "git.force-push.preview"
      | "git.force-push.apply";
  }
>;

// Services are owned by the worker entry point; this handler only executes commands.
export async function handleGitCommand(command: GitCommand): Promise<unknown> {
  switch (command.type) {
    case "git.change-summary":
      return readGitChangeSummary(command.cwd, command);
    case "git.history":
      return readGitHistory(
        command.cwd,
        command.limit,
        command.cursor,
        command.revisions,
        command.options,
      );
    case "git.graph.snapshot":
      return readGitGraphSnapshot(
        command.cwd,
        command.revision,
        command.rootPath,
        command.maxNodes,
      );
    case "git.graph.metrics":
      return readGitGraphMetrics(
        command.cwd,
        command.revision,
        command.rootPath,
        command.maxNodes,
        command.includeBlame,
      );
    case "git.graph.commit-overlay":
      return createGitGraphCommitOverlay(
        await readGitCommitDetail(command.cwd, command.revision),
        command.rootPath,
      );
    case "git.file.history":
      return readGitFileHistory(
        command.cwd,
        command.path,
        command.revision,
        command.limit,
        command.cursor,
      );
    case "git.file.blame":
      return readGitFileBlame(
        command.cwd,
        command.path,
        command.revision,
        command.limit,
        command.cursor,
      );
    case "git.commit.search":
      return searchGitCommits(
        command.cwd,
        command.query,
        command.limit,
        command.cursor,
      );
    case "git.recovery.list":
      return readGitRecoveryCandidates(
        command.cwd,
        command.kind,
        command.limit,
        command.cursor,
      );
    case "git.recovery.preview":
      return previewGitRecoveryAction(command.cwd, command.action);
    case "git.recovery.apply":
      return applyGitRecoveryAction(
        command.cwd,
        command.request.action,
        command.request.token,
        command.request.confirmation,
      );
    case "git.commit.get":
      return readGitCommitDetail(
        command.cwd,
        command.revision,
        command.parentIndex,
        command.revisions,
      );
    case "git.commit.signature.get":
      return readGitCommitSignature(command.cwd, command.revision);
    case "git.refs.list":
      return readGitRevisionCandidates(command.cwd);
    case "git.compare":
      return readGitComparison(
        command.cwd,
        command.left,
        command.right,
        command.mode,
      );
    case "git.revision.diff":
      return readGitRevisionFileDiff(
        command.cwd,
        command.revision,
        command.baseRevision,
        command.path,
        command.contextLines,
      );
    case "git.status":
      return readGitStatus(command.cwd);
    case "git.diff":
      return readGitFileDiff(
        command.cwd,
        command.path,
        command.scope,
        command.contextLines,
      );
    case "git.patch.preview":
      return previewGitPartialPatch(command.cwd, command.request);
    case "git.patch.apply":
      return applyGitPartialPatch(command.cwd, command.request, command.token);
    case "git.stash.list":
      return readGitStashes(command.cwd);
    case "git.stash.create":
      return createGitStash(command.cwd, command.request);
    case "git.stash.diff":
      return readGitStashFileDiff(
        command.cwd,
        command.hash,
        command.path,
        command.contextLines,
      );
    case "git.stash.action.preview":
      return previewGitStashAction(command.cwd, command.action);
    case "git.stash.action.apply":
      return applyGitStashAction(command.cwd, command.action, command.token);
    case "git.worktree.changes.preview":
      return previewGitWorktreeChangesMove(
        command.cwd,
        command.sourceCwd,
        command.request,
      );
    case "git.worktree.changes.apply":
      return applyGitWorktreeChangesMove(
        command.cwd,
        command.sourceCwd,
        command.request,
        command.token,
      );
    case "git.branch.list":
      return readGitBranches(command.cwd);
    case "git.branch.action.preview":
      return previewGitBranchAction(command.cwd, command.action);
    case "git.branch.action.apply":
      return applyGitBranchAction(command.cwd, command.action, command.token);
    case "git.remote.list":
      return readGitRemotes(command.cwd);
    case "git.remote.action.preview":
      return previewGitRemoteAction(command.cwd, command.action);
    case "git.remote.action.apply":
      return applyGitRemoteAction(command.cwd, command.action, command.token);
    case "git.submodule.list":
      return readGitSubmodules(command.cwd);
    case "git.submodule.action.preview":
      return previewGitSubmoduleAction(command.cwd, command.action);
    case "git.submodule.action.apply":
      return applyGitSubmoduleAction(
        command.cwd,
        command.action,
        command.token,
      );
    case "git.lfs.status":
      return readGitLfsStatus(command.cwd, command.refreshLocks);
    case "git.lfs.action.preview":
      return previewGitLfsAction(command.cwd, command.action);
    case "git.lfs.action.apply":
      return applyGitLfsAction(command.cwd, command.action, command.token);
    case "git.tag.list":
      return readGitTags(command.cwd);
    case "git.tag.get":
      return readGitTagDetail(command.cwd, command.name);
    case "git.tag.action.preview":
      return previewGitTagAction(command.cwd, command.action);
    case "git.tag.action.apply":
      return applyGitTagAction(command.cwd, command.action, command.token);
    case "git.commit.action.preview":
      return previewGitCommitAction(command.cwd, command.action);
    case "git.commit.action.apply":
      return applyGitCommitAction(command.cwd, command.action, command.token);
    case "git.operation.preview":
      return previewGitManagedOperation(command.cwd, command.action);
    case "git.operation.start":
      return startGitManagedOperation(
        command.cwd,
        command.action,
        command.token,
      );
    case "git.operation.inspect":
      return inspectGitManagedOperation(command.cwd, command.context);
    case "git.operation.control":
      return controlGitManagedOperation(
        command.cwd,
        command.context,
        command.action,
      );
    case "git.operation.amend":
      return amendGitManagedOperation(
        command.cwd,
        command.context,
        command.message,
      );
    case "git.conflicts.list":
      return listGitConflicts(command.cwd);
    case "git.conflicts.get":
      return readGitConflict(command.cwd, command.path);
    case "git.conflicts.preview":
      return previewGitConflictResolution(command.cwd, command.request);
    case "git.conflicts.apply":
      return applyGitConflictResolution(
        command.cwd,
        command.request,
        command.token,
      );
    case "git.action":
      return runGitAction(command.cwd, command.action);
    case "git.force-push.preview":
      return previewGitForcePush(command.cwd);
    case "git.force-push.apply":
      return applyGitForcePush(command.cwd, command.token);
  }
}
