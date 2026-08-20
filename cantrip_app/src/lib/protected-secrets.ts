import {
  clearSensitiveBytes,
  computeBlindLookupTag,
  decryptProtectedSecret,
  deriveLookupKey,
  encryptProtectedSecret,
} from "@cantrip/crypto";
import {
  encryptedMcpServerCreateSchema,
  encryptedMcpServerUpdateSchema,
  encryptedModelProviderCreateSchema,
  encryptedModelProviderUpdateSchema,
  isManagedCodeGraphMcpName,
  mcpServerConfigurationSchema,
  mcpServerListSchema,
  mcpServerSummarySchema,
  mcpServerWireListSchema,
  mcpServerWireSummarySchema,
  modelProviderCreateSchema,
  modelProviderUpdateSchema,
  type EncryptedMcpServerCreate,
  type EncryptedMcpServerUpdate,
  type EncryptedModelProviderCreate,
  type EncryptedModelProviderUpdate,
  type McpServerConfiguration,
  type McpServerSummary,
  type McpServerWireSummary,
  type ModelProviderCreate,
  type ModelProviderUpdate,
} from "@cantrip/protocol";
import { providerApiKeyProtectedContentSchema } from "@cantrip/protocol/protected-secrets";

import type { ClientSessionContext } from "./client-session";
import { getClientSession } from "./client-session";
import type { ClientEncryptionService } from "./client-encryption";
import { ClientEncryptionError, clientEncryption } from "./client-encryption";

type TrustedOptions = {
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
};

function context(options: TrustedOptions) {
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
  return {
    keyRevision: snapshot.masterKeyRevision,
    ownerId: session.user.id,
    service,
  };
}

async function protectProviderApiKey(input: {
  apiKey: string;
  providerId: string;
  options: TrustedOptions;
}) {
  const encryption = context(input.options);
  const componentKey = encryption.service.componentKey({
    component: "provider-credential",
    identity: {
      ownerId: encryption.ownerId,
      serverId: encryption.service.getSnapshot().identity!.serverId,
    },
    keyRevision: encryption.keyRevision,
  });
  try {
    return encryptProtectedSecret({
      ownerId: encryption.ownerId,
      component: "provider-credential",
      table: "model_providers",
      rowId: input.providerId,
      field: "protected_api_key",
      keyRevision: encryption.keyRevision,
      componentKey,
      content: { version: 1, apiKey: input.apiKey },
      contentSchema: providerApiKeyProtectedContentSchema,
      maximumBytes: 16 * 1_024,
    });
  } finally {
    clearSensitiveBytes(componentKey);
  }
}

export async function protectModelProviderCreate(
  raw: ModelProviderCreate,
  options: TrustedOptions = {},
): Promise<EncryptedModelProviderCreate> {
  const input = modelProviderCreateSchema.parse(raw);
  const id = crypto.randomUUID();
  return encryptedModelProviderCreateSchema.parse({
    ...input,
    id,
    apiKey: undefined,
    protectedApiKey: input.apiKey
      ? await protectProviderApiKey({
          apiKey: input.apiKey,
          providerId: id,
          options,
        })
      : null,
  });
}

export async function protectModelProviderUpdate(
  providerId: string,
  raw: ModelProviderUpdate,
  options: TrustedOptions = {},
): Promise<EncryptedModelProviderUpdate> {
  const input = modelProviderUpdateSchema.parse(raw);
  return encryptedModelProviderUpdateSchema.parse({
    ...input,
    apiKey: undefined,
    ...(input.apiKey === undefined
      ? {}
      : {
          protectedApiKey: input.apiKey
            ? await protectProviderApiKey({
                apiKey: input.apiKey,
                providerId,
                options,
              })
            : null,
        }),
  });
}

async function protectMcpConfiguration(
  id: string,
  raw: McpServerConfiguration,
  options: TrustedOptions,
) {
  const input = mcpServerConfigurationSchema.parse(raw);
  if (isManagedCodeGraphMcpName(input.name)) {
    throw new Error("The CodeGraph MCP name is reserved by Cantrip.");
  }
  const encryption = context(options);
  const identity = encryption.service.getSnapshot().identity!;
  const componentKey = encryption.service.componentKey({
    component: "mcp-secret",
    identity,
    keyRevision: encryption.keyRevision,
  });
  const lookupKey = deriveLookupKey({
    componentKey,
    ownerId: encryption.ownerId,
    component: "mcp-secret",
    table: "mcp_servers",
    field: "name",
    keyRevision: encryption.keyRevision,
  });
  try {
    return {
      enabled: input.enabled,
      nameBlindIndex: computeBlindLookupTag(
        lookupKey,
        input.name.toLowerCase(),
      ),
      protectedConfiguration: await encryptProtectedSecret({
        ownerId: encryption.ownerId,
        component: "mcp-secret",
        table: "mcp_servers",
        rowId: id,
        field: "protected_configuration",
        keyRevision: encryption.keyRevision,
        componentKey,
        content: input,
        contentSchema: mcpServerConfigurationSchema,
        maximumBytes: 1024 * 1024,
      }),
    };
  } finally {
    clearSensitiveBytes(lookupKey);
    clearSensitiveBytes(componentKey);
  }
}

export async function protectMcpServerCreate(
  raw: McpServerConfiguration,
  options: TrustedOptions = {},
): Promise<EncryptedMcpServerCreate> {
  const id = crypto.randomUUID();
  return encryptedMcpServerCreateSchema.parse({
    id,
    ...(await protectMcpConfiguration(id, raw, options)),
  });
}

export async function protectMcpServerUpdate(
  id: string,
  raw: McpServerConfiguration,
  options: TrustedOptions = {},
): Promise<EncryptedMcpServerUpdate> {
  return encryptedMcpServerUpdateSchema.parse(
    await protectMcpConfiguration(id, raw, options),
  );
}

export async function openMcpServerWireSummary(
  raw: unknown,
  options: TrustedOptions = {},
): Promise<McpServerSummary> {
  const wire = mcpServerWireSummarySchema.parse(raw);
  const encryption = context(options);
  const keyRevision = wire.protectedConfiguration.keyRevision;
  const componentKey = encryption.service.componentKey({
    component: "mcp-secret",
    identity: encryption.service.getSnapshot().identity!,
    keyRevision,
  });
  try {
    const configuration = await decryptProtectedSecret({
      ownerId: encryption.ownerId,
      component: "mcp-secret",
      table: "mcp_servers",
      rowId: wire.id,
      field: "protected_configuration",
      keyRevision,
      componentKey,
      encrypted: wire.protectedConfiguration,
      contentSchema: mcpServerConfigurationSchema,
      maximumBytes: 1024 * 1024,
    });
    return mcpServerSummarySchema.parse({
      ...configuration,
      enabled: wire.enabled,
      id: wire.id,
      scope: wire.scope,
      projectId: wire.projectId,
      createdAt: wire.createdAt,
      updatedAt: wire.updatedAt,
    });
  } finally {
    clearSensitiveBytes(componentKey);
  }
}

export async function openMcpServerWireList(
  raw: unknown,
  options: TrustedOptions = {},
) {
  const wire = mcpServerWireListSchema.parse(raw);
  return mcpServerListSchema.parse(
    await Promise.all(
      wire.map((server) => openMcpServerWireSummary(server, options)),
    ),
  );
}
