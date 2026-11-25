import {
  clearSensitiveBytes,
  decryptPayload,
  deriveFieldKey,
  encryptPayload,
} from "@cantrip/crypto";
import {
  councilAgentCreateSchema,
  councilAgentUpdateSchema,
  councilAgentWireListSchema,
  councilAgentWireSummarySchema,
  standaloneChatWireSummarySchema,
  type CouncilAgentWireSummary,
} from "@cantrip/protocol";

import { request } from "@/lib/api-client";
import { chatTitleEncryption } from "@/lib/chat-title-encryption";
import {
  ClientEncryptionError,
  clientEncryption,
} from "@/lib/client-encryption";
import {
  getClientSessionIdentitySnapshot,
  type ClientSessionIdentitySnapshot,
} from "@/lib/client-session";
import { decodePrivateDisplayLabelForClient } from "@/lib/private-label-encryption";

export type CouncilAgent = Omit<CouncilAgentWireSummary, "titleProtection"> & {
  title: string;
};

const path = "/api/council/agents";

function requireIdentity() {
  const snapshot = getClientSessionIdentitySnapshot();
  if (!snapshot) {
    throw new ClientEncryptionError("locked", "Sign in to open Council.");
  }
  return snapshot;
}

function encryptionIdentity(snapshot: ClientSessionIdentitySnapshot) {
  return { ownerId: snapshot.userId, serverId: snapshot.serverId };
}

function roleKey(
  snapshot: ClientSessionIdentitySnapshot,
  id: string,
  keyRevision: number,
) {
  const identity = encryptionIdentity(snapshot);
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
  try {
    return {
      associatedData,
      key: deriveFieldKey({ ...associatedData, componentKey }),
    };
  } finally {
    clearSensitiveBytes(componentKey);
  }
}

async function sealRole(
  snapshot: ClientSessionIdentitySnapshot,
  id: string,
  role: string,
) {
  const keyRevision = clientEncryption.getSnapshot().masterKeyRevision;
  if (!keyRevision) {
    throw new ClientEncryptionError(
      "locked",
      "Unlock encryption to edit Council agents.",
    );
  }
  const plaintext = new TextEncoder().encode(role.trim());
  try {
    if (plaintext.length === 0 || plaintext.length > 32 * 1024) {
      throw new Error("Enter a Council role of up to 32 KiB.");
    }
    const { associatedData, key } = roleKey(snapshot, id, keyRevision);
    try {
      return await encryptPayload({ key, plaintext, associatedData });
    } finally {
      clearSensitiveBytes(key);
    }
  } finally {
    clearSensitiveBytes(plaintext);
  }
}

export async function openCouncilRole(agent: CouncilAgent) {
  const { associatedData, key } = roleKey(
    requireIdentity(),
    agent.id,
    agent.protectedRole.keyRevision,
  );
  try {
    const plaintext = await decryptPayload({
      key,
      associatedData,
      envelope: agent.protectedRole,
    });
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    } finally {
      clearSensitiveBytes(plaintext);
    }
  } finally {
    clearSensitiveBytes(key);
  }
}

async function openAgent(
  snapshot: ClientSessionIdentitySnapshot,
  agent: CouncilAgentWireSummary,
): Promise<CouncilAgent> {
  const { titleProtection, ...fields } = agent;
  const title = await decodePrivateDisplayLabelForClient({
    identity: encryptionIdentity(snapshot),
    opaque: titleProtection,
    recordKind: "chat",
    rowId: agent.id,
  });
  return { ...fields, title };
}

export async function listCouncilAgents() {
  const expectedIdentity = requireIdentity();
  const agents = councilAgentWireListSchema.parse(
    await request(path, undefined, { expectedIdentity }),
  );
  return Promise.all(agents.map((agent) => openAgent(expectedIdentity, agent)));
}

export async function getCouncilChat(id: string) {
  const expectedIdentity = requireIdentity();
  const chat = await request(
    `${path}/${encodeURIComponent(id)}/chat`,
    undefined,
    { expectedIdentity },
  );
  return chatTitleEncryption.openStandalone(
    standaloneChatWireSummarySchema.parse(chat),
  );
}

export async function createCouncilAgent(title: string, role: string) {
  const expectedIdentity = requireIdentity();
  const id = crypto.randomUUID();
  const body = councilAgentCreateSchema.parse({
    id,
    titleProtection: await chatTitleEncryption.protect(id, title),
    protectedRole: await sealRole(expectedIdentity, id, role),
  });
  return openAgent(
    expectedIdentity,
    councilAgentWireSummarySchema.parse(
      await request(
        path,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
        { expectedIdentity },
      ),
    ),
  );
}

export async function updateCouncilAgent(
  agent: CouncilAgent,
  change: { title: string; role: string; primary: boolean },
) {
  const expectedIdentity = requireIdentity();
  const body = councilAgentUpdateSchema.parse({
    expectedRevision: agent.revision,
    titleProtection: await chatTitleEncryption.protect(agent.id, change.title),
    protectedRole: await sealRole(expectedIdentity, agent.id, change.role),
    primary: change.primary,
  });
  return openAgent(
    expectedIdentity,
    councilAgentWireSummarySchema.parse(
      await request(
        `${path}/${encodeURIComponent(agent.id)}`,
        { method: "PATCH", body: JSON.stringify(body) },
        { expectedIdentity },
      ),
    ),
  );
}
