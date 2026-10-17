import {
  type RepositoryMetadataValues,
  repositoryMetadataValuesSchema,
  repositoryMetadataResultSchema,
} from "@cantrip/protocol/repository-operation";
import { getClientSession } from "@/lib/client-session";
import { clientEncryption } from "@/lib/client-encryption";
import {
  deriveLookupKey,
  computeBlindLookupTag,
  clearSensitiveBytes,
} from "@cantrip/crypto";
import type {
  ProjectGithubConversionRepository,
  ProjectGithubRoutingRepository,
} from "@cantrip/protocol";
import { projectGithubRoutingRepositorySchema } from "@cantrip/protocol";
import { runProtectedWorkerRepositoryOperation } from "./repository-operations";

export async function registerWorkerRepositoryMetadata(input: {
  scopeId: string;
  values: RepositoryMetadataValues;
  workerId: string;
}) {
  return runProtectedWorkerRepositoryOperation({
    workerId: input.workerId,
    scopeId: input.scopeId,
    type: "repository.metadata.register",
    arguments: { values: repositoryMetadataValuesSchema.parse(input.values) },
    resultSchema: repositoryMetadataResultSchema,
  });
}

export async function resolveWorkerRepositoryMetadata(input: {
  scopeId: string;
  values: RepositoryMetadataValues;
  workerId: string;
}) {
  return runProtectedWorkerRepositoryOperation({
    workerId: input.workerId,
    scopeId: input.scopeId,
    type: "repository.metadata.resolve",
    arguments: { values: repositoryMetadataValuesSchema.parse(input.values) },
    resultSchema: repositoryMetadataResultSchema,
  });
}

function repositoryIdentityBlindIndex(repositoryId: string): string {
  const session = getClientSession();
  const snapshot = clientEncryption.getSnapshot();
  if (
    !session ||
    snapshot.status !== "ready" ||
    !snapshot.masterKeyRevision ||
    snapshot.identity?.ownerId !== session.user.id ||
    snapshot.identity.serverId !== session.serverId
  ) {
    throw new Error("Encryption must be unlocked for this account.");
  }
  const componentKey = clientEncryption.componentKey({
    component: "repository-content",
    identity: snapshot.identity,
    keyRevision: snapshot.masterKeyRevision,
  });
  const lookupKey = deriveLookupKey({
    componentKey,
    ownerId: session.user.id,
    component: "repository-content",
    table: "projects",
    field: "github_repository_identity",
    keyRevision: snapshot.masterKeyRevision,
  });
  try {
    return computeBlindLookupTag(lookupKey, repositoryId);
  } finally {
    clearSensitiveBytes(lookupKey);
    clearSensitiveBytes(componentKey);
  }
}

export async function protectWorkerRepositoryIdentity(input: {
  projectId: string;
  repository: ProjectGithubConversionRepository;
  workerId: string;
}): Promise<{
  repository: ProjectGithubRoutingRepository;
  repositoryBlindIndex: string;
}> {
  const result = await registerWorkerRepositoryMetadata({
    workerId: input.workerId,
    scopeId: input.projectId,
    values: input.repository,
  });
  return {
    repository: projectGithubRoutingRepositorySchema.parse(result.values),
    repositoryBlindIndex: repositoryIdentityBlindIndex(
      input.repository.repositoryId,
    ),
  };
}
