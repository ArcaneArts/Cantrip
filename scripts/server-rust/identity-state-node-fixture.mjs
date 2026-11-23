// Direct calls to the current reference facade, including the intentional no-ops.
export async function identityStateFixture(repository, request) {
  switch (request.op) {
    case "identity-state-whitelisted":
      return repository.accountEmailIsWhitelisted(request.email);
    case "identity-state-rotate-csrf":
      return repository.rotateSessionCsrfToken(request.session, request.hash);
    case "identity-state-prune-mobile":
      await repository.pruneMobileSignInGrants(new Date(request.before));
      return null;
    case "identity-state-active-principal":
      return repository.encryptionRegistry.findActiveWorkerPrincipal(
        request.owner,
        request.worker,
      );
    case "identity-state-principal-by-id":
      return repository.encryptionRegistry.findWorkerPrincipalById(
        request.owner,
        request.worker,
        request.principal,
      );
    case "identity-state-replace-principal":
      return repository.encryptionRegistry.replaceActiveWorkerPrincipal(
        request.owner,
        request.worker,
        request.input,
      );
    case "identity-state-online-count":
      return repository.onlineWorkerCount(request.owner);
    case "identity-state-operation-usage":
      await repository.recordModelOperationUsage(request.owner, request.input);
      return null;
    case "identity-state-legacy-noops":
      await repository.migrateProviderSecrets();
      await repository.migrateProviderAccountCredentialSecrets();
      await repository.migrateMcpServerSecrets();
      return null;
    default:
      throw Error("Unknown identity fixture operation");
  }
}
