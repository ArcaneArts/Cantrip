import {
  SURFACE_PRIVATE_STATE_PROTECTED_CONTENT_BYTES_LIMIT,
  surfacePrivateStateContextSchema,
  surfacePrivateStateOpaqueSchema,
  surfacePrivateStateProtectedContentSchema,
  type SurfacePrivateStateContext,
  type SurfacePrivateStateOpaque,
  type SurfacePrivateStateProtectedContent,
  type SurfacePrivateStateRecordKind,
  type SurfacePrivateStateResource,
} from "@cantrip/protocol/surface-private-state";
import {
  encryptionAssociatedDataSchema,
  type EncryptionAssociatedData,
} from "@cantrip/protocol/encryption";
import { sha256 } from "@noble/hashes/sha2.js";

import { clearSensitiveBytes, encodeBase64Url } from "./bytes.js";
import { deriveFieldKey } from "./kdf.js";
import {
  CantripDecryptionError,
  decryptPayload,
  encryptPayload,
} from "./payload.js";

const component = "surface-private-state" as const;
const formatVersion = 1 as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const surfacePrivateStateResourceTables = {
  "terminal-row": "terminals",
  "terminal-operation": "protocol:terminal-operation",
  "explorer-row": "explorers",
  "explorer-operation": "protocol:explorer-operation",
  "browser-row": "browsers",
  "browser-remote-surface": "remote_surfaces",
  "browser-operation": "protocol:browser-operation",
  "remote-desktop-row": "project_views",
  "remote-desktop-surface": "remote_surfaces",
  "remote-desktop-operation": "protocol:remote-desktop-operation",
  "remote-desktop-inventory": "protocol:remote-desktop-inventory",
} as const satisfies Record<SurfacePrivateStateResource, string>;

export const surfacePrivateStateFields = {
  "terminal-state": "protected_terminal_state",
  "explorer-state": "protected_explorer_state",
  "browser-state": "protected_browser_state",
  "remote-desktop-state": "protected_remote_desktop_state",
  "remote-desktop-inventory": "protected_remote_desktop_inventory",
} as const satisfies Record<SurfacePrivateStateRecordKind, string>;

const allowedResources = {
  "terminal-state": ["terminal-row", "terminal-operation"],
  "explorer-state": ["explorer-row", "explorer-operation"],
  "browser-state": [
    "browser-row",
    "browser-remote-surface",
    "browser-operation",
  ],
  "remote-desktop-state": [
    "remote-desktop-row",
    "remote-desktop-surface",
    "remote-desktop-operation",
  ],
  "remote-desktop-inventory": ["remote-desktop-inventory"],
} as const satisfies Record<
  SurfacePrivateStateRecordKind,
  readonly SurfacePrivateStateResource[]
>;

const persistentResources = new Set<SurfacePrivateStateResource>([
  "terminal-row",
  "explorer-row",
  "browser-row",
  "browser-remote-surface",
  "remote-desktop-row",
  "remote-desktop-surface",
]);

function validatedContext(
  input: SurfacePrivateStateContext,
): SurfacePrivateStateContext {
  const context = surfacePrivateStateContextSchema.parse(input);
  if (
    !allowedResources[context.recordKind].includes(context.resource as never)
  ) {
    throw new Error("Surface private-state kind and resource do not agree.");
  }
  if (
    persistentResources.has(context.resource) ===
    (context.operationId !== null)
  ) {
    throw new Error(
      persistentResources.has(context.resource)
        ? "Persistent surface state cannot carry an operation ID."
        : "Ephemeral surface state requires an operation ID.",
    );
  }
  return context;
}

function serverBinding(serverId: string): string {
  return encodeBase64Url(sha256(encoder.encode(serverId)));
}

export function surfacePrivateStateAssociatedData(input: {
  ownerId: string;
  context: SurfacePrivateStateContext;
  keyRevision: number;
}): EncryptionAssociatedData {
  const context = validatedContext(input.context);
  return encryptionAssociatedDataSchema.parse({
    ownerId: input.ownerId,
    component,
    table: surfacePrivateStateResourceTables[context.resource],
    rowId: JSON.stringify([
      serverBinding(context.serverId),
      context.resourceId,
      context.operationId,
      context.recordKind,
    ]),
    field: surfacePrivateStateFields[context.recordKind],
    formatVersion,
    keyRevision: input.keyRevision,
  });
}

export async function encryptSurfacePrivateState(input: {
  ownerId: string;
  context: SurfacePrivateStateContext;
  keyRevision: number;
  componentKey: Uint8Array;
  content: SurfacePrivateStateProtectedContent;
}): Promise<SurfacePrivateStateOpaque> {
  const context = validatedContext(input.context);
  const content = surfacePrivateStateProtectedContentSchema.parse(
    input.content,
  );
  if (content.classification.recordKind !== context.recordKind) {
    throw new Error("Surface private-state content and context do not agree.");
  }
  const plaintext = encoder.encode(JSON.stringify(content));
  if (
    plaintext.byteLength > SURFACE_PRIVATE_STATE_PROTECTED_CONTENT_BYTES_LIMIT
  ) {
    clearSensitiveBytes(plaintext);
    throw new Error("Protected surface state exceeds its encoded byte limit.");
  }
  const associatedData = surfacePrivateStateAssociatedData(input);
  const fieldKey = deriveFieldKey({
    componentKey: input.componentKey,
    ownerId: input.ownerId,
    component,
    table: associatedData.table,
    field: associatedData.field,
    keyRevision: input.keyRevision,
  });
  try {
    return surfacePrivateStateOpaqueSchema.parse({
      classification: content.classification,
      protectedState: {
        formatVersion,
        keyRevision: input.keyRevision,
        envelope: await encryptPayload({
          key: fieldKey,
          plaintext,
          associatedData,
        }),
      },
    });
  } finally {
    clearSensitiveBytes(fieldKey);
    clearSensitiveBytes(plaintext);
  }
}

export async function decryptSurfacePrivateState(input: {
  ownerId: string;
  context: SurfacePrivateStateContext;
  keyRevision: number;
  componentKey: Uint8Array;
  opaque: SurfacePrivateStateOpaque;
}): Promise<SurfacePrivateStateProtectedContent> {
  let context: SurfacePrivateStateContext;
  let opaque: SurfacePrivateStateOpaque;
  try {
    context = validatedContext(input.context);
    opaque = surfacePrivateStateOpaqueSchema.parse(input.opaque);
    if (
      opaque.protectedState.keyRevision !== input.keyRevision ||
      opaque.classification.recordKind !== context.recordKind
    ) {
      throw new CantripDecryptionError();
    }
  } catch {
    throw new CantripDecryptionError();
  }
  const associatedData = surfacePrivateStateAssociatedData({
    ownerId: input.ownerId,
    context,
    keyRevision: input.keyRevision,
  });
  const fieldKey = deriveFieldKey({
    componentKey: input.componentKey,
    ownerId: input.ownerId,
    component,
    table: associatedData.table,
    field: associatedData.field,
    keyRevision: input.keyRevision,
  });
  let plaintext: Uint8Array | null = null;
  try {
    plaintext = await decryptPayload({
      key: fieldKey,
      envelope: opaque.protectedState.envelope,
      associatedData,
    });
    if (
      plaintext.byteLength > SURFACE_PRIVATE_STATE_PROTECTED_CONTENT_BYTES_LIMIT
    ) {
      throw new CantripDecryptionError();
    }
    const content = surfacePrivateStateProtectedContentSchema.parse(
      JSON.parse(decoder.decode(plaintext)),
    );
    if (
      content.classification.recordKind !== opaque.classification.recordKind ||
      content.classification.recordKind !== context.recordKind
    ) {
      throw new CantripDecryptionError();
    }
    return content;
  } catch {
    throw new CantripDecryptionError();
  } finally {
    if (plaintext) clearSensitiveBytes(plaintext);
    clearSensitiveBytes(fieldKey);
  }
}
