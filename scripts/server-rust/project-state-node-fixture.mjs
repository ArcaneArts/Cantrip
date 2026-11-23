// Call the current facade instead of reproducing its SQL in the oracle.
export async function projectStateFixture(repository, request) {
  const { owner, project = "github" } = request;
  switch (request.op) {
    case "project-state-policy":
      return repository.updateProjectWorktreePolicy(owner, project, {
        policy: request.policy,
      });
    case "project-state-preferred":
      return repository.updateProjectPreferredWorker(
        owner,
        project,
        request.worker,
      );
    case "project-state-replica":
      return repository.getProjectReplica(owner, project, request.replica);
    case "project-state-worktrees":
      return repository.listProjectWorktrees(owner, project);
    case "project-state-selector":
      return repository.resolveExecutionTargetSelector(
        owner,
        project,
        request.kind ?? null,
        request.selector ?? null,
        request.context,
        Array.isArray(request.connected)
          ? (worker) => request.connected.includes(worker)
          : undefined,
      );
    case "project-state-skill-keys":
      return repository.listChatSkillAudienceKeys(
        owner,
        request.worker,
        request.provider,
      );
    case "project-state-secret-statuses":
      return repository.getRunConfigurationSecretStatuses(
        owner,
        project,
        request.references,
      );
    case "project-state-protected-secrets":
      return repository.listRunConfigurationProtectedSecrets(
        owner,
        project,
        request.references,
      );
    case "project-state-operation-result":
      return repository.getRunConfigurationRuntimeOperationResult(
        owner,
        request.operation,
        request.executionKey ?? "worker",
      );
    case "project-state-runtime-capture":
      return repository.getRunConfigurationRuntimeCapture(
        owner,
        request.runtime,
      );
    case "project-state-has-github":
      return repository.hasGithubProject(owner, request.blindIndex);
    case "project-state-create-github":
      return repository.createGithubProject(owner, request.input);
    case "project-state-delete":
      return repository.deleteProject(owner, project);
    default:
      throw Error("Unknown project state fixture operation");
  }
}
