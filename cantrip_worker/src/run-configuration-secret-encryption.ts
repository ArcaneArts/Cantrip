import { clearSensitiveBytes, decryptProtectedSecret } from "@cantrip/crypto";
import {
  RUN_CONFIGURATION_SECRET_PROTECTED_CONTENT_BYTES_LIMIT,
  runConfigurationProtectedSecretSchema,
  runConfigurationSecretProtectionRowId,
  runConfigurationSecretValueContentSchema,
  type RunConfigurationProtectedSecret,
} from "@cantrip/protocol/run-configuration-secrets";

import type { WorkerEncryptionService } from "./worker-encryption.js";

export async function openRunConfigurationSecretValue(input: {
  projectId: string;
  secret: RunConfigurationProtectedSecret;
  service: Pick<WorkerEncryptionService, "componentKey" | "ownerId">;
}): Promise<string> {
  const secret = runConfigurationProtectedSecretSchema.parse(input.secret);
  const component = input.service.componentKey(
    "run-content",
    secret.protectedValue.keyRevision,
  );
  try {
    const content = await decryptProtectedSecret({
      ownerId: input.service.ownerId(),
      component: "run-content",
      table: "run_configuration_secrets",
      rowId: runConfigurationSecretProtectionRowId({
        projectId: input.projectId,
        reference: secret.reference,
      }),
      field: "protected_value",
      keyRevision: secret.protectedValue.keyRevision,
      componentKey: component.key,
      encrypted: secret.protectedValue,
      contentSchema: runConfigurationSecretValueContentSchema,
      maximumBytes: RUN_CONFIGURATION_SECRET_PROTECTED_CONTENT_BYTES_LIMIT,
    });
    return content.value;
  } finally {
    clearSensitiveBytes(component.key);
  }
}
