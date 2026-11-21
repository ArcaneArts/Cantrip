import type { RepositoryOperationType } from "@cantrip/protocol/repository-operation";

const workerScopedGithubOperationTypes = new Set<RepositoryOperationType>([
  "github.auth.status",
  "github.repositories.cached",
  "github.repositories.list",
  "github.repository-owners.list",
  "github.repositories.create",
]);

export function githubOperationRequiresCheckout(
  type: RepositoryOperationType,
): boolean {
  return (
    type.startsWith("github.") && !workerScopedGithubOperationTypes.has(type)
  );
}
