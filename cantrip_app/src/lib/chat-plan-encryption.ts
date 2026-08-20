import {
  clearSensitiveBytes,
  decryptChatPlanProtectedContent,
} from "@cantrip/crypto";
import {
  chatPlanStateSchema,
  encryptedChatPlanWireStateSchema,
  type ChatPlanState,
} from "@cantrip/protocol";

import type { ClientSessionContext } from "./client-session";
import { getClientSession } from "./client-session";
import type { ClientEncryptionService } from "./client-encryption";
import { ClientEncryptionError, clientEncryption } from "./client-encryption";

type TrustedOptions = {
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
};

function encryptionContext(options: TrustedOptions) {
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
    identity: { ownerId: session.user.id, serverId: session.serverId },
    service,
  };
}

export async function openEncryptedChatPlanWireState(
  chatId: string,
  raw: unknown,
  options: TrustedOptions = {},
): Promise<ChatPlanState> {
  const wire = encryptedChatPlanWireStateSchema.parse(raw);
  if (wire.chatId !== chatId) {
    throw new Error("Encrypted Plan Mode state belongs to another chat.");
  }
  if (!wire.state) {
    return chatPlanStateSchema.parse({
      mode: wire.mode,
      explanation: null,
      steps: [],
      question: null,
    });
  }

  const context = encryptionContext(options);
  const componentKey = context.service.componentKey({
    component: "chat-content",
    identity: context.identity,
    keyRevision: wire.state.protectedContent.keyRevision,
  });
  try {
    const opened = await decryptChatPlanProtectedContent({
      ownerId: context.identity.ownerId,
      chatId,
      keyRevision: wire.state.protectedContent.keyRevision,
      componentKey,
      encrypted: wire.state.protectedContent,
      publicClassification: wire.state.classification,
    });
    return chatPlanStateSchema.parse({
      mode: wire.mode,
      explanation: opened.explanation,
      steps: opened.steps,
      question: opened.question,
    });
  } finally {
    clearSensitiveBytes(componentKey);
  }
}
