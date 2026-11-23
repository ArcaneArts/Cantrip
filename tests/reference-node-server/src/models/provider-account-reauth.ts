import { PROVIDER_REAUTH_REQUIRED_MESSAGE } from "@cantrip/protocol";

import type { ServerRepository } from "../db/repository.js";

type ProviderAccountReauthRepository = Pick<
  ServerRepository,
  | "getModelProviderAccountCredential"
  | "updateModelProviderAccountCredentialState"
>;

export function isProviderAccountReauthenticationRequired(
  error: unknown,
): boolean {
  return (
    (error instanceof Error ? error.message : String(error)) ===
    PROVIDER_REAUTH_REQUIRED_MESSAGE
  );
}

export async function markProviderAccountReauthenticationRequired(
  repository: ProviderAccountReauthRepository,
  input: { accountId: string; ownerId: string; providerId: string },
): Promise<boolean> {
  const credential = await repository.getModelProviderAccountCredential(
    input.ownerId,
    input.providerId,
    input.accountId,
  );
  if (!credential) return false;
  if (credential.state === "reauth-required") return true;
  if (credential.state !== "signed-in") return false;
  return repository.updateModelProviderAccountCredentialState({
    ...input,
    expectedRevision: credential.revision,
    state: "reauth-required",
  });
}
