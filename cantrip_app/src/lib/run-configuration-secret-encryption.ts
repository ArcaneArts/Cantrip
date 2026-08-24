import { clearSensitiveBytes, encryptProtectedSecret } from "@cantrip/crypto";
import {
  RUN_CONFIGURATION_SECRET_PROTECTED_CONTENT_BYTES_LIMIT,
  runConfigurationSecretProtectionRowId,
  runConfigurationSecretValueContentSchema,
} from "@cantrip/protocol/run-configuration-secrets";
import { runConfigurationSecretReferenceSchema } from "@cantrip/protocol/run-configuration-definitions";

import type { ClientEncryptionService } from "./client-encryption";
import { ClientEncryptionError, clientEncryption } from "./client-encryption";
import type { ClientSessionContext } from "./client-session";
import { getClientSession } from "./client-session";

interface RunConfigurationSecretEncryptionOptions {
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
}

export async function protectRunConfigurationSecretValue(input: {
  projectId: string;
  reference: string;
  value: string;
  options?: RunConfigurationSecretEncryptionOptions;
}) {
  const options = input.options ?? {};
  const service = options.service ?? clientEncryption;
  const session = (options.session ?? getClientSession)();
  const snapshot = service.getSnapshot();
  if (
    !session ||
    snapshot.status !== "ready" ||
    !snapshot.masterKeyRevision ||
    snapshot.identity?.ownerId !== session.user.id ||
    snapshot.identity.serverId !== session.serverId
  ) {
    throw new ClientEncryptionError(
      "locked",
      "Encryption must be unlocked for this account.",
    );
  }
  const reference = runConfigurationSecretReferenceSchema.parse(
    input.reference,
  );
  const componentKey = service.componentKey({
    component: "run-content",
    identity: snapshot.identity,
    keyRevision: snapshot.masterKeyRevision,
  });
  try {
    return await encryptProtectedSecret({
      ownerId: session.user.id,
      component: "run-content",
      table: "run_configuration_secrets",
      rowId: runConfigurationSecretProtectionRowId({
        projectId: input.projectId,
        reference,
      }),
      field: "protected_value",
      keyRevision: snapshot.masterKeyRevision,
      componentKey,
      content: { version: 1, value: input.value },
      contentSchema: runConfigurationSecretValueContentSchema,
      maximumBytes: RUN_CONFIGURATION_SECRET_PROTECTED_CONTENT_BYTES_LIMIT,
    });
  } finally {
    clearSensitiveBytes(componentKey);
  }
}
