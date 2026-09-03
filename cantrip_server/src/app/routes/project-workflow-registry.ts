import type { FastifyInstance } from "fastify";

import { installChatRelocationRoutes } from "./chat-relocations.js";
import { installGithubRepositoryCatalogRoutes } from "./github-repository-catalog.js";
import { installProjectAutomationRoutes } from "./project-automations.js";
import { installProjectCatalogAndPlacementRoutes } from "./project-catalog-and-placement.js";
import { installProjectChatCatalogRoutes } from "./chat-catalogs.js";
import { installProjectFolderSetupRoutes } from "./project-folder-setup.js";
import { installProjectGitActionAndHistoryRoutes } from "./project-git-actions-and-history.js";
import { installProjectGitStatusAndActionRoutes } from "./project-git-status-and-actions.js";
import { installProjectGithubContentRoutes } from "./project-github-content.js";
import { installProjectGithubConversionRoutes } from "./project-github-conversion.js";
import { installProjectGithubImportRoute } from "./project-github-import.js";
import { installProjectMcpServerRoutes } from "./project-mcp-servers.js";
import { installProjectNetworkShareRoutes } from "./project-network-shares.js";
import { installProjectRemovalRoute } from "./project-removal.js";
import { installProjectReplicaRoutes } from "./project-replicas.js";
import {
  installProjectInsightRoutes,
  installProjectOrderRoute,
  installProjectPreferenceRoutes,
} from "./project-settings-and-insights.js";
import { installProjectWorkspaceRoutes } from "./project-workspaces.js";
import { installProjectWorktreeGitCommitActionRoutes } from "./project-worktree-git-commit-actions.js";
import { installProjectWorktreeGitHistoryAndGraphRoutes } from "./project-worktree-git-history-and-graph.js";
import { installProjectWorktreeGitInspectionAndRecoveryRoutes } from "./project-worktree-git-inspection-and-recovery.js";
import { installProjectWorktreeGitManagedOperationRoutes } from "./project-worktree-git-managed-operations.js";
import { installProjectWorktreeGitPublishingRoutes } from "./project-worktree-git-publishing.js";
import { installProjectWorktreeGitResourceRoutes } from "./project-worktree-git-resources.js";
import { installProjectWorktreeGitRevisionAndPatchRoutes } from "./project-worktree-git-revisions-and-patches.js";
import { installProjectWorktreeGitStashRoutes } from "./project-worktree-git-stashes.js";
import { installProjectWorktreePullRequestRoutes } from "./project-worktree-pull-requests.js";
import { installProjectWorktreeStatusRoute } from "./project-worktree-status.js";
import { installProjectWorktreeRoutes } from "./project-worktrees.js";

export type ProjectWorkflowRouteDependencies = Parameters<
  typeof installGithubRepositoryCatalogRoutes
>[1] &
  Parameters<typeof installProjectCatalogAndPlacementRoutes>[1] &
  Parameters<typeof installProjectReplicaRoutes>[1] &
  Parameters<typeof installChatRelocationRoutes>[1] &
  Parameters<typeof installProjectAutomationRoutes>[1] &
  Parameters<typeof installProjectMcpServerRoutes>[1] &
  Parameters<typeof installProjectWorkspaceRoutes>[1] &
  Parameters<typeof installProjectWorktreePullRequestRoutes>[1] &
  Parameters<typeof installProjectWorktreeGitInspectionAndRecoveryRoutes>[1] &
  Parameters<typeof installProjectNetworkShareRoutes>[1] &
  Parameters<typeof installProjectPreferenceRoutes>[1] &
  Parameters<typeof installProjectWorktreeRoutes>[1] &
  Parameters<typeof installProjectWorktreeStatusRoute>[1] &
  Parameters<typeof installProjectWorktreeGitHistoryAndGraphRoutes>[1] &
  Parameters<typeof installProjectWorktreeGitCommitActionRoutes>[1] &
  Parameters<typeof installProjectWorktreeGitManagedOperationRoutes>[1] &
  Parameters<typeof installProjectWorktreeGitRevisionAndPatchRoutes>[1] &
  Parameters<typeof installProjectWorktreeGitStashRoutes>[1] &
  Parameters<typeof installProjectWorktreeGitResourceRoutes>[1] &
  Parameters<typeof installProjectWorktreeGitPublishingRoutes>[1] &
  Parameters<typeof installProjectGitActionAndHistoryRoutes>[1] &
  Parameters<typeof installProjectInsightRoutes>[1] &
  Parameters<typeof installProjectGithubContentRoutes>[1] &
  Parameters<typeof installProjectGitStatusAndActionRoutes>[1] &
  Parameters<typeof installProjectOrderRoute>[1] &
  Parameters<typeof installProjectRemovalRoute>[1] &
  Parameters<typeof installProjectFolderSetupRoutes>[1] &
  Parameters<typeof installProjectGithubConversionRoutes>[1] &
  Parameters<typeof installProjectGithubImportRoute>[1] &
  Parameters<typeof installProjectChatCatalogRoutes>[1];

/** Registers the contiguous project, worktree, and Git tranche. */
export function installProjectWorkflowRoutes(
  app: FastifyInstance,
  dependencies: ProjectWorkflowRouteDependencies,
): void {
  installGithubRepositoryCatalogRoutes(app, dependencies);

  installProjectCatalogAndPlacementRoutes(app, dependencies);

  installProjectReplicaRoutes(app, dependencies);

  installChatRelocationRoutes(app, dependencies);

  installProjectAutomationRoutes(app, dependencies);

  installProjectMcpServerRoutes(app, dependencies);

  installProjectWorkspaceRoutes(app, dependencies);

  installProjectWorktreePullRequestRoutes(app, dependencies);

  installProjectWorktreeGitInspectionAndRecoveryRoutes(app, dependencies);

  installProjectNetworkShareRoutes(app, dependencies);

  installProjectPreferenceRoutes(app, dependencies);

  installProjectWorktreeRoutes(app, dependencies);

  installProjectWorktreeStatusRoute(app, dependencies);

  installProjectWorktreeGitHistoryAndGraphRoutes(app, dependencies);

  installProjectWorktreeGitCommitActionRoutes(app, dependencies);

  installProjectWorktreeGitManagedOperationRoutes(app, dependencies);

  installProjectWorktreeGitRevisionAndPatchRoutes(app, dependencies);

  installProjectWorktreeGitStashRoutes(app, dependencies);

  installProjectWorktreeGitResourceRoutes(app, dependencies);

  installProjectWorktreeGitPublishingRoutes(app, dependencies);

  installProjectGitActionAndHistoryRoutes(app, dependencies);

  installProjectInsightRoutes(app, dependencies);

  installProjectGithubContentRoutes(app, dependencies);

  installProjectGitStatusAndActionRoutes(app, dependencies);

  installProjectOrderRoute(app, dependencies);

  installProjectRemovalRoute(app, dependencies);

  installProjectFolderSetupRoutes(app, dependencies);

  installProjectGithubConversionRoutes(app, dependencies);

  installProjectGithubImportRoute(app, dependencies);

  installProjectChatCatalogRoutes(app, dependencies);
}
