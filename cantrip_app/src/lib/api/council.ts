import {
  clearSensitiveBytes,
  deriveFieldKey,
  encryptPayload,
} from "@cantrip/crypto";
import {
  councilAgentCreateSchema,
  councilAgentWireSummarySchema,
} from "@cantrip/protocol";

import { request } from "@/lib/api-client";
import { chatTitleEncryption } from "@/lib/chat-title-encryption";
import {
  ClientEncryptionError,
  clientEncryption,
} from "@/lib/client-encryption";
import { getClientSessionIdentitySnapshot } from "@/lib/client-session";

export async function createCouncilAgent(title: string, role: string) {
  const expectedIdentity = getClientSessionIdentitySnapshot();
  const keyRevision = clientEncryption.getSnapshot().masterKeyRevision;
  if (!expectedIdentity || !keyRevision) {
    throw new ClientEncryptionError(
      "locked",
      "Unlock encryption before creating a Council agent.",
    );
  }
  const id = crypto.randomUUID();
  const identity = {
    ownerId: expectedIdentity.userId,
    serverId: expectedIdentity.serverId,
  };
  const plaintext = new TextEncoder().encode(role.trim());
  if (plaintext.length === 0 || plaintext.length > 32 * 1024) {
    throw new Error("Enter a Council role of up to 32 KiB.");
  }
  const associatedData = {
    ownerId: identity.ownerId,
    component: "chat-content" as const,
    table: "council_agents",
    rowId: id,
    field: "role",
    formatVersion: 1 as const,
    keyRevision,
  };
  const componentKey = clientEncryption.componentKey({
    component: associatedData.component,
    identity,
    keyRevision,
  });
  const key = deriveFieldKey({ ...associatedData, componentKey });
  try {
    const protectedRole = await encryptPayload({
      key,
      plaintext,
      associatedData,
    });
    const titleProtection = await chatTitleEncryption.protect(id, title);
    return councilAgentWireSummarySchema.parse(
      await request(
        "/api/council/agents",
        {
          method: "POST",
          body: JSON.stringify(
            councilAgentCreateSchema.parse({
              id,
              titleProtection,
              protectedRole,
            }),
          ),
        },
        { expectedIdentity },
      ),
    );
  } finally {
    clearSensitiveBytes(plaintext);
    clearSensitiveBytes(componentKey);
    clearSensitiveBytes(key);
  }
}
