import {
  clearSensitiveBytes,
  computeBlindLookupTag,
  decryptProtectedSecret,
  deriveLookupKey,
  encryptProtectedSecret,
} from "@cantrip/crypto";
import {
  mcpServerConfigurationSchema,
  type McpServerConfiguration,
  type McpServerOpaqueRuntime,
  type ProviderLegacyCredential,
  type WorkerCommand,
} from "@cantrip/protocol";
import {
  providerApiKeyProtectedContentSchema,
  providerCredentialProtectedContentSchema,
  providerCredentialPublicMetadataSchema,
  protectedProviderCredentialSchema,
  type ProtectedProviderCredential,
} from "@cantrip/protocol/protected-secrets";

import type { WorkerEncryptionService } from "./worker-encryption.js";

export type ProtectedRuntimeProvider = Extract<
  WorkerCommand,
  { type: "chat.turn" }
>["provider"];

export type RuntimeProvider = ProtectedRuntimeProvider & {
  apiKey: string | null;
};

export async function openRuntimeProvider(input: {
  provider: ProtectedRuntimeProvider;
  service: WorkerEncryptionService;
}): Promise<RuntimeProvider> {
  const { protectedApiKey } = input.provider;
  if (!protectedApiKey) return { ...input.provider, apiKey: null };
  const component = input.service.componentKey("provider-credential");
  try {
    const content = await decryptProtectedSecret({
      ownerId: input.service.ownerId(),
      component: "provider-credential",
      table: "model_providers",
      rowId: input.provider.id,
      field: "protected_api_key",
      keyRevision: protectedApiKey.keyRevision,
      componentKey: component.key,
      encrypted: protectedApiKey,
      contentSchema: providerApiKeyProtectedContentSchema,
      maximumBytes: 16 * 1_024,
    });
    return { ...input.provider, apiKey: content.apiKey };
  } finally {
    clearSensitiveBytes(component.key);
  }
}

export async function openMcpServers(input: {
  servers: McpServerOpaqueRuntime[];
  service: WorkerEncryptionService;
}): Promise<McpServerConfiguration[]> {
  return Promise.all(
    input.servers
      .filter(({ enabled }) => enabled)
      .map(async (server) => {
        const component = input.service.componentKey("mcp-secret");
        try {
          const configuration = await decryptProtectedSecret({
            ownerId: input.service.ownerId(),
            component: "mcp-secret",
            table: "mcp_servers",
            rowId: server.id,
            field: "protected_configuration",
            keyRevision: server.protectedConfiguration.keyRevision,
            componentKey: component.key,
            encrypted: server.protectedConfiguration,
            contentSchema: mcpServerConfigurationSchema,
            maximumBytes: 1024 * 1024,
          });
          return mcpServerConfigurationSchema.parse({
            ...configuration,
            enabled: server.enabled,
          });
        } finally {
          clearSensitiveBytes(component.key);
        }
      }),
  );
}

function providerSubject(credential: ProviderLegacyCredential): string {
  return credential.kind === "chatgpt"
    ? `chatgpt:${credential.accountId}`
    : `grok:${credential.userId}`;
}

export async function protectProviderCredential(input: {
  accountId: string;
  credential: ProviderLegacyCredential;
  service: WorkerEncryptionService;
}): Promise<{
  credential: ProtectedProviderCredential;
  metadata: {
    expiresAt: string | null;
  };
}> {
  const credential = providerCredentialProtectedContentSchema.parse(
    input.credential,
  );
  const component = input.service.componentKey("provider-credential");
  const lookupKey = deriveLookupKey({
    componentKey: component.key,
    ownerId: input.service.ownerId(),
    component: "provider-credential",
    table: "model_provider_accounts",
    field: "subject",
    keyRevision: component.keyRevision,
  });
  try {
    return {
      credential: protectedProviderCredentialSchema.parse({
        subjectBlindIndex: computeBlindLookupTag(
          lookupKey,
          providerSubject(credential),
        ),
        protectedCredential: await encryptProtectedSecret({
          ownerId: input.service.ownerId(),
          component: "provider-credential",
          table: "model_provider_accounts",
          rowId: input.accountId,
          field: "protected_credential",
          keyRevision: component.keyRevision,
          componentKey: component.key,
          content: credential,
          contentSchema: providerCredentialProtectedContentSchema,
        }),
      }),
      metadata: providerCredentialPublicMetadataSchema.parse({
        expiresAt: credential.expiresAt
          ? new Date(credential.expiresAt).toISOString()
          : null,
      }),
    };
  } finally {
    clearSensitiveBytes(lookupKey);
    clearSensitiveBytes(component.key);
  }
}

export async function openProviderCredential(input: {
  accountId: string;
  credential: ProtectedProviderCredential;
  service: WorkerEncryptionService;
}): Promise<ProviderLegacyCredential> {
  const component = input.service.componentKey("provider-credential");
  try {
    const credential = await decryptProtectedSecret({
      ownerId: input.service.ownerId(),
      component: "provider-credential",
      table: "model_provider_accounts",
      rowId: input.accountId,
      field: "protected_credential",
      keyRevision: input.credential.protectedCredential.keyRevision,
      componentKey: component.key,
      encrypted: input.credential.protectedCredential,
      contentSchema: providerCredentialProtectedContentSchema,
    });
    const lookupKey = deriveLookupKey({
      componentKey: component.key,
      ownerId: input.service.ownerId(),
      component: "provider-credential",
      table: "model_provider_accounts",
      field: "subject",
      keyRevision: component.keyRevision,
    });
    try {
      if (
        computeBlindLookupTag(lookupKey, providerSubject(credential)) !==
        input.credential.subjectBlindIndex
      ) {
        throw new Error("Provider credential identity binding is invalid.");
      }
    } finally {
      clearSensitiveBytes(lookupKey);
    }
    return credential;
  } finally {
    clearSensitiveBytes(component.key);
  }
}

export function providerCredentialSubjectBlindIndex(input: {
  credential: ProviderLegacyCredential;
  service: WorkerEncryptionService;
}): string {
  const component = input.service.componentKey("provider-credential");
  const lookupKey = deriveLookupKey({
    componentKey: component.key,
    ownerId: input.service.ownerId(),
    component: "provider-credential",
    table: "model_provider_accounts",
    field: "subject",
    keyRevision: component.keyRevision,
  });
  try {
    return computeBlindLookupTag(lookupKey, providerSubject(input.credential));
  } finally {
    clearSensitiveBytes(lookupKey);
    clearSensitiveBytes(component.key);
  }
}
