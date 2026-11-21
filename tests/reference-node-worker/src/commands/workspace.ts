import {
  discoverWorkspaceRepositories,
  validateWorkspaceRepositoryImport,
} from "../workspace-repository-discovery.js";
import type { WorkerCommand, WorkerEvent } from "@cantrip/protocol";

export type WorkspaceCommand = Extract<
  WorkerCommand,
  {
    type:
      | "workspace.repositories.discover"
      | "workspace.repository-import.validate";
  }
>;

// Services are owned by the worker entry point; this handler only executes commands.
export async function handleWorkspaceCommand(
  command: WorkspaceCommand,
  emit: (event: WorkerEvent) => void,
): Promise<unknown> {
  switch (command.type) {
    case "workspace.repositories.discover": {
      const result = await discoverWorkspaceRepositories(
        command.rootPath,
        { maxDepth: command.depth === -1 ? Infinity : command.depth },
        (progress) => {
          emit({
            type: "workspace.repositories.discovery-progress",
            jobId: command.jobId,
            attempt: command.attempt,
            progress,
          });
        },
      );
      return {
        jobId: command.jobId,
        attempt: command.attempt,
        candidates: result.candidates.map((candidate) => ({
          path: candidate.canonicalPath,
          displayPath: candidate.relativePath,
          originUrl: candidate.originUrl,
          github: candidate.github,
          repositoryFingerprint: candidate.repositoryFingerprint,
          classification: candidate.classification,
          diagnosticCode: candidate.diagnosticCode,
        })),
        counts: {
          candidates: result.candidates.length,
          collapsedRepositories: result.collapsedRepositories,
          rejectedRepositories: result.rejectedRepositories,
          scannedDirectories: result.scannedDirectories,
          scannedEntries: result.scannedEntries,
          skippedSymlinks: result.skippedSymlinks,
          unreadableDirectories: result.unreadableDirectories,
        },
        diagnosticCode: result.truncated ? "scan-truncated" : null,
        truncated: result.truncated,
      };
    }
    case "workspace.repository-import.validate":
      return validateWorkspaceRepositoryImport(command);
  }
}
