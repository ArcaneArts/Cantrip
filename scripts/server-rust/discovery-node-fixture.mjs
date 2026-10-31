// Development-only adapter to the actual repository; it owns no domain logic.
export async function discoveryFixture(repo, r, catalog) {
  switch (r.op) {
    case "discovery-workspace-list":
      return catalog.listProjectWorkspaceWire(r.owner);
    case "discovery-workspace-create":
      return catalog.createEncryptedProjectWorkspace(r.owner, r.input);
    case "discovery-workspace-attach":
      return catalog.createVerifiedAttachedProjectWorkspace(r.owner, r.input);
    case "discovery-workspace-update":
      return catalog.updateEncryptedProjectWorkspace(
        r.owner,
        r.workspace,
        r.input,
      );
    case "discovery-workspace-delete-plan":
      return catalog.getProjectWorkspaceDeletionPlan(r.owner, r.workspace);
    case "discovery-workspace-delete":
      return catalog.deleteProjectWorkspace(r.owner, r.workspace);
    case "discovery-project-removal-context":
      return catalog.getProjectRemovalContext(r.owner, r.project);
    case "discovery-project-delete":
      return catalog.deleteProject(r.owner, r.project);
    case "discovery-snapshot":
      return repo.getSnapshot(r.owner, r.workspace);
    case "discovery-queue":
      return repo.queue(r.owner, r.workspace, r.input);
    case "discovery-claim":
      return repo.claimNext();
    case "discovery-renew":
      return repo.renewLease(r.job, r.command, r.attempt);
    case "discovery-block":
      return repo.block(r.job, r.command, r.error);
    case "discovery-fail":
      return repo.fail(r.job, r.command, r.error);
    case "discovery-complete":
      return repo.complete(r.job, r.command, r.input);
    case "discovery-recover":
      return repo.recoverInterrupted(r.force, new Date(r.now));
    case "discovery-requeue":
      return repo.requeueRetryableForWorker(r.worker);
    case "discovery-import-queue":
      return repo.queueImports(r.owner, r.workspace, r.input);
    case "discovery-import-claim":
      return repo.claimNextImport();
    case "discovery-import-renew":
      return repo.renewImportLease(r.claimed);
    case "discovery-import-block":
      return repo.blockImport(r.claimed, r.error);
    case "discovery-import-fail":
      return repo.failImport(r.claimed, r.error);
    case "discovery-import-complete":
      return repo.completeImport(r.claimed, r.result);
    case "discovery-import-recover":
      return repo.recoverInterruptedImports(r.force, new Date(r.now));
    case "discovery-import-requeue":
      return repo.requeueRetryableImportsForWorker(r.worker);
    default:
      throw new Error("Unknown discovery fixture operation " + r.op);
  }
}
