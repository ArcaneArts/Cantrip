import {
  authReauthenticationResultSchema,
  authReauthenticationSchema,
} from "@cantrip/protocol";
import {
  accountEncryptionProfileInitializeResultSchema,
  accountEncryptionProfileInitializeSchema,
  accountEncryptionProfileSchema,
  accountEncryptionProfileStateSchema,
  accountPasswordEncryptionChangeSchema,
  encryptionKeyGrantCreateSchema,
  encryptionKeyGrantListSchema,
  encryptionKeyGrantSchema,
  encryptionPrincipalApprovalSchema,
  encryptionPrincipalCreateSchema,
  encryptionPrincipalListSchema,
  encryptionPrincipalSchema,
  encryptionRevocationSchema,
  type AccountEncryptionProfileInitialize,
  type AccountPasswordEncryptionChange,
  type EncryptionKeyGrantCreate,
  type EncryptionPrincipalCreate,
} from "@cantrip/protocol/encryption";

import { post, request, requestResponse } from "./api-client";

export async function getAccountEncryptionProfile() {
  return accountEncryptionProfileStateSchema.parse(
    await request("/api/encryption/profile"),
  );
}

export async function initializeAccountEncryptionProfile(
  input: AccountEncryptionProfileInitialize,
) {
  const response = await requestResponse(
    "/api/encryption/profile/initialize",
    {
      method: "POST",
      body: JSON.stringify(
        accountEncryptionProfileInitializeSchema.parse(input),
      ),
    },
    [409],
  );
  return accountEncryptionProfileInitializeResultSchema.parse(
    await response.json(),
  );
}

export async function listEncryptionPrincipals() {
  return encryptionPrincipalListSchema.parse(
    await request("/api/encryption/principals"),
  );
}

export async function createEncryptionPrincipal(
  input: EncryptionPrincipalCreate,
) {
  return encryptionPrincipalSchema.parse(
    await post(
      "/api/encryption/principals",
      encryptionPrincipalCreateSchema.parse(input),
    ),
  );
}

export async function approveEncryptionPrincipal(
  principalId: string,
  expectedRevision: number,
) {
  return encryptionPrincipalSchema.parse(
    await post(
      `/api/encryption/principals/${encodeURIComponent(principalId)}/approve`,
      encryptionPrincipalApprovalSchema.parse({ expectedRevision }),
    ),
  );
}

export async function listEncryptionGrants(principalId: string) {
  return encryptionKeyGrantListSchema.parse(
    await request(
      `/api/encryption/principals/${encodeURIComponent(principalId)}/grants`,
    ),
  );
}

export async function createEncryptionGrant(
  principalId: string,
  input: EncryptionKeyGrantCreate,
) {
  return encryptionKeyGrantSchema.parse(
    await post(
      `/api/encryption/principals/${encodeURIComponent(principalId)}/grants`,
      encryptionKeyGrantCreateSchema.parse(input),
    ),
  );
}

export async function revokeEncryptionGrant(
  grantId: string,
  expectedRevision: number,
  reason: string,
) {
  return encryptionKeyGrantSchema.parse(
    await post(
      `/api/encryption/grants/${encodeURIComponent(grantId)}/revoke`,
      encryptionRevocationSchema.parse({ expectedRevision, reason }),
    ),
  );
}

export async function reauthenticateForEncryption(password: string) {
  return authReauthenticationResultSchema.parse(
    await post(
      "/api/auth/reauthenticate",
      authReauthenticationSchema.parse({ password }),
    ),
  );
}

export async function changeAccountPasswordWithEncryption(
  input: AccountPasswordEncryptionChange,
) {
  return accountEncryptionProfileSchema.parse(
    await post(
      "/api/account/password",
      accountPasswordEncryptionChangeSchema.parse(input),
    ),
  );
}
