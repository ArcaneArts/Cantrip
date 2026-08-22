import {
  clearSensitiveBytes,
  decryptChatComposerDraftProtectedContent,
  encryptChatComposerDraftProtectedContent,
} from "@cantrip/crypto";
import {
  chatComposerDraftSchema,
  encryptedChatComposerDraftWireStateSchema,
  type ChatComposerDraft,
} from "@cantrip/protocol";
import {
  chatComposerDraftOpaqueStateSchema,
  type ChatComposerDraftOpaqueState,
} from "@cantrip/protocol/communication-content";

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
    keyRevision: snapshot.masterKeyRevision,
    service,
  };
}

export async function protectChatComposerDraft(
  chatId: string,
  draft: ChatComposerDraft,
  options: TrustedOptions = {},
): Promise<ChatComposerDraftOpaqueState> {
  const parsed = chatComposerDraftSchema.parse(draft);
  const context = encryptionContext(options);
  const componentKey = context.service.componentKey({
    component: "chat-content",
    identity: context.identity,
    keyRevision: context.keyRevision,
  });
  try {
    return chatComposerDraftOpaqueStateSchema.parse({
      protectedContent: await encryptChatComposerDraftProtectedContent({
        ownerId: context.identity.ownerId,
        chatId,
        keyRevision: context.keyRevision,
        componentKey,
        content: { version: 1, ...parsed },
      }),
    });
  } finally {
    clearSensitiveBytes(componentKey);
  }
}

export async function openChatComposerDraft(
  chatId: string,
  raw: unknown,
  options: TrustedOptions = {},
): Promise<ChatComposerDraft | null> {
  const wire = encryptedChatComposerDraftWireStateSchema.parse(raw);
  if (wire.chatId !== chatId) {
    throw new Error("Encrypted composer draft belongs to another chat.");
  }
  if (!wire.state) return null;
  const context = encryptionContext(options);
  const keyRevision = wire.state.protectedContent.keyRevision;
  const componentKey = context.service.componentKey({
    component: "chat-content",
    identity: context.identity,
    keyRevision,
  });
  try {
    const opened = await decryptChatComposerDraftProtectedContent({
      ownerId: context.identity.ownerId,
      chatId,
      keyRevision,
      componentKey,
      encrypted: wire.state.protectedContent,
    });
    return chatComposerDraftSchema.parse({
      text: opened.text,
      mode: opened.mode,
      reasoningEffort: opened.reasoningEffort,
    });
  } finally {
    clearSensitiveBytes(componentKey);
  }
}
