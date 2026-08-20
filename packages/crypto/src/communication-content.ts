import {
  chatMessageProtectedClassificationSchema,
  chatMessageProtectedContentSchema,
  chatPlanProtectedClassificationSchema,
  chatPlanProtectedContentSchema,
  encryptedChatMessageProtectedContentSchema,
  encryptedChatPlanProtectedContentSchema,
  encryptedInteractionRequestContentSchema,
  encryptedInteractionResponseContentSchema,
  encryptedQueuedPromptProtectedContentSchema,
  interactionProtectedClassificationSchema,
  interactionRequestProtectedContentSchema,
  interactionResponseProtectedContentSchema,
  queuedPromptProtectedClassificationSchema,
  queuedPromptProtectedContentSchema,
  CHAT_MESSAGE_PROTECTED_CONTENT_BYTES_LIMIT,
  CHAT_PLAN_PROTECTED_CONTENT_BYTES_LIMIT,
  INTERACTION_PROTECTED_CONTENT_BYTES_LIMIT,
  QUEUED_PROMPT_PROTECTED_CONTENT_BYTES_LIMIT,
  type ChatMessageProtectedClassification,
  type ChatMessageProtectedContent,
  type ChatPlanProtectedClassification,
  type ChatPlanProtectedContent,
  type EncryptedChatMessageProtectedContent,
  type EncryptedChatPlanProtectedContent,
  type EncryptedInteractionRequestContent,
  type EncryptedInteractionResponseContent,
  type EncryptedQueuedPromptProtectedContent,
  type InteractionProtectedClassification,
  type InteractionRequestProtectedContent,
  type InteractionResponseProtectedContent,
  type QueuedPromptProtectedClassification,
  type QueuedPromptProtectedContent,
} from "@cantrip/protocol/communication-content";
import {
  encryptionAssociatedDataSchema,
  type EncryptedPayloadEnvelope,
  type EncryptionAssociatedData,
  type EncryptionComponentScope,
} from "@cantrip/protocol/encryption";

import { clearSensitiveBytes } from "./bytes.js";
import { deriveFieldKey } from "./kdf.js";
import {
  CantripDecryptionError,
  decryptPayload,
  encryptPayload,
} from "./payload.js";

const formatVersion = 1 as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

interface Parser<T> {
  parse(value: unknown): T;
}

interface ProtectedEnvelope {
  formatVersion: 1;
  keyRevision: number;
  envelope: EncryptedPayloadEnvelope;
}

type CommunicationComponent = Extract<
  EncryptionComponentScope,
  "chat-content" | "interaction-content"
>;

function associatedData(input: {
  ownerId: string;
  component: CommunicationComponent;
  table: string;
  rowId: string;
  field: string;
  keyRevision: number;
}): EncryptionAssociatedData {
  return encryptionAssociatedDataSchema.parse({
    ownerId: input.ownerId,
    component: input.component,
    table: input.table,
    rowId: input.rowId,
    field: input.field,
    formatVersion,
    keyRevision: input.keyRevision,
  });
}

export function chatMessageContentAssociatedData(input: {
  ownerId: string;
  messageId: string;
  keyRevision: number;
}): EncryptionAssociatedData {
  return associatedData({
    ownerId: input.ownerId,
    component: "chat-content",
    table: "chat_messages",
    rowId: input.messageId,
    field: "protected_content",
    keyRevision: input.keyRevision,
  });
}

export function queuedPromptContentAssociatedData(input: {
  ownerId: string;
  promptId: string;
  keyRevision: number;
}): EncryptionAssociatedData {
  return associatedData({
    ownerId: input.ownerId,
    component: "chat-content",
    table: "queued_prompts",
    rowId: input.promptId,
    field: "protected_content",
    keyRevision: input.keyRevision,
  });
}

export function chatPlanContentAssociatedData(input: {
  ownerId: string;
  chatId: string;
  keyRevision: number;
}): EncryptionAssociatedData {
  return associatedData({
    ownerId: input.ownerId,
    component: "chat-content",
    table: "chats",
    rowId: input.chatId,
    field: "protected_plan",
    keyRevision: input.keyRevision,
  });
}

export function interactionRequestContentAssociatedData(input: {
  ownerId: string;
  requestKey: string;
  keyRevision: number;
}): EncryptionAssociatedData {
  return associatedData({
    ownerId: input.ownerId,
    component: "interaction-content",
    table: "agent_interaction_requests",
    rowId: input.requestKey,
    field: "protected_payload",
    keyRevision: input.keyRevision,
  });
}

export function interactionResponseContentAssociatedData(input: {
  ownerId: string;
  requestKey: string;
  keyRevision: number;
}): EncryptionAssociatedData {
  return associatedData({
    ownerId: input.ownerId,
    component: "interaction-content",
    table: "agent_interaction_requests",
    rowId: input.requestKey,
    field: "protected_response",
    keyRevision: input.keyRevision,
  });
}

function encodeProtectedContent<T>(
  schema: Parser<T>,
  content: T,
  maximumBytes: number,
): Uint8Array {
  const plaintext = encoder.encode(JSON.stringify(schema.parse(content)));
  if (plaintext.byteLength > maximumBytes) {
    clearSensitiveBytes(plaintext);
    throw new Error("Protected communication content exceeds its byte limit.");
  }
  return plaintext;
}

function decodeProtectedContent<T>(
  schema: Parser<T>,
  plaintext: Uint8Array,
  maximumBytes: number,
): T {
  if (plaintext.byteLength > maximumBytes) throw new CantripDecryptionError();
  try {
    return schema.parse(JSON.parse(decoder.decode(plaintext)));
  } catch {
    throw new CantripDecryptionError();
  }
}

async function encryptProtectedContent<T, E extends ProtectedEnvelope>(input: {
  componentKey: Uint8Array;
  content: T;
  contentSchema: Parser<T>;
  envelopeSchema: Parser<E>;
  associatedData: EncryptionAssociatedData;
  maximumBytes: number;
}): Promise<E> {
  const plaintext = encodeProtectedContent(
    input.contentSchema,
    input.content,
    input.maximumBytes,
  );
  const fieldKey = deriveFieldKey({
    componentKey: input.componentKey,
    ownerId: input.associatedData.ownerId,
    component: input.associatedData.component,
    table: input.associatedData.table,
    field: input.associatedData.field,
    keyRevision: input.associatedData.keyRevision,
  });
  try {
    return input.envelopeSchema.parse({
      formatVersion,
      keyRevision: input.associatedData.keyRevision,
      envelope: await encryptPayload({
        key: fieldKey,
        plaintext,
        associatedData: input.associatedData,
      }),
    });
  } finally {
    clearSensitiveBytes(fieldKey);
    clearSensitiveBytes(plaintext);
  }
}

async function decryptProtectedContent<T, E extends ProtectedEnvelope>(input: {
  componentKey: Uint8Array;
  encrypted: E;
  envelopeSchema: Parser<E>;
  contentSchema: Parser<T>;
  associatedData: EncryptionAssociatedData;
  maximumBytes: number;
}): Promise<T> {
  let encrypted: E;
  try {
    encrypted = input.envelopeSchema.parse(input.encrypted);
    if (encrypted.keyRevision !== input.associatedData.keyRevision) {
      throw new CantripDecryptionError();
    }
  } catch {
    throw new CantripDecryptionError();
  }
  const fieldKey = deriveFieldKey({
    componentKey: input.componentKey,
    ownerId: input.associatedData.ownerId,
    component: input.associatedData.component,
    table: input.associatedData.table,
    field: input.associatedData.field,
    keyRevision: input.associatedData.keyRevision,
  });
  let plaintext: Uint8Array | null = null;
  try {
    plaintext = await decryptPayload({
      key: fieldKey,
      envelope: encrypted.envelope,
      associatedData: input.associatedData,
    });
    return decodeProtectedContent(
      input.contentSchema,
      plaintext,
      input.maximumBytes,
    );
  } finally {
    if (plaintext) clearSensitiveBytes(plaintext);
    clearSensitiveBytes(fieldKey);
  }
}

function requireMatchingClassification<T>(
  schema: Parser<T>,
  encryptedClassification: T,
  publicClassification: T,
): void {
  try {
    if (
      JSON.stringify(schema.parse(encryptedClassification)) !==
      JSON.stringify(schema.parse(publicClassification))
    ) {
      throw new CantripDecryptionError();
    }
  } catch {
    throw new CantripDecryptionError();
  }
}

export async function encryptChatMessageProtectedContent(input: {
  ownerId: string;
  messageId: string;
  keyRevision: number;
  componentKey: Uint8Array;
  content: ChatMessageProtectedContent;
}): Promise<EncryptedChatMessageProtectedContent> {
  return encryptProtectedContent({
    componentKey: input.componentKey,
    content: input.content,
    contentSchema: chatMessageProtectedContentSchema,
    envelopeSchema: encryptedChatMessageProtectedContentSchema,
    associatedData: chatMessageContentAssociatedData(input),
    maximumBytes: CHAT_MESSAGE_PROTECTED_CONTENT_BYTES_LIMIT,
  });
}

export async function decryptChatMessageProtectedContent(input: {
  ownerId: string;
  messageId: string;
  keyRevision: number;
  componentKey: Uint8Array;
  encrypted: EncryptedChatMessageProtectedContent;
  publicClassification: ChatMessageProtectedClassification;
}): Promise<ChatMessageProtectedContent> {
  const content = await decryptProtectedContent({
    componentKey: input.componentKey,
    encrypted: input.encrypted,
    envelopeSchema: encryptedChatMessageProtectedContentSchema,
    contentSchema: chatMessageProtectedContentSchema,
    associatedData: chatMessageContentAssociatedData(input),
    maximumBytes: CHAT_MESSAGE_PROTECTED_CONTENT_BYTES_LIMIT,
  });
  requireMatchingClassification(
    chatMessageProtectedClassificationSchema,
    content.classification,
    input.publicClassification,
  );
  return content;
}

export async function encryptChatPlanProtectedContent(input: {
  ownerId: string;
  chatId: string;
  keyRevision: number;
  componentKey: Uint8Array;
  content: ChatPlanProtectedContent;
}): Promise<EncryptedChatPlanProtectedContent> {
  return encryptProtectedContent({
    componentKey: input.componentKey,
    content: input.content,
    contentSchema: chatPlanProtectedContentSchema,
    envelopeSchema: encryptedChatPlanProtectedContentSchema,
    associatedData: chatPlanContentAssociatedData(input),
    maximumBytes: CHAT_PLAN_PROTECTED_CONTENT_BYTES_LIMIT,
  });
}

export async function decryptChatPlanProtectedContent(input: {
  ownerId: string;
  chatId: string;
  keyRevision: number;
  componentKey: Uint8Array;
  encrypted: EncryptedChatPlanProtectedContent;
  publicClassification: ChatPlanProtectedClassification;
}): Promise<ChatPlanProtectedContent> {
  const content = await decryptProtectedContent({
    componentKey: input.componentKey,
    encrypted: input.encrypted,
    envelopeSchema: encryptedChatPlanProtectedContentSchema,
    contentSchema: chatPlanProtectedContentSchema,
    associatedData: chatPlanContentAssociatedData(input),
    maximumBytes: CHAT_PLAN_PROTECTED_CONTENT_BYTES_LIMIT,
  });
  requireMatchingClassification(
    chatPlanProtectedClassificationSchema,
    content.classification,
    input.publicClassification,
  );
  return content;
}

export async function encryptQueuedPromptProtectedContent(input: {
  ownerId: string;
  promptId: string;
  keyRevision: number;
  componentKey: Uint8Array;
  content: QueuedPromptProtectedContent;
}): Promise<EncryptedQueuedPromptProtectedContent> {
  return encryptProtectedContent({
    componentKey: input.componentKey,
    content: input.content,
    contentSchema: queuedPromptProtectedContentSchema,
    envelopeSchema: encryptedQueuedPromptProtectedContentSchema,
    associatedData: queuedPromptContentAssociatedData(input),
    maximumBytes: QUEUED_PROMPT_PROTECTED_CONTENT_BYTES_LIMIT,
  });
}

export async function decryptQueuedPromptProtectedContent(input: {
  ownerId: string;
  promptId: string;
  keyRevision: number;
  componentKey: Uint8Array;
  encrypted: EncryptedQueuedPromptProtectedContent;
  publicClassification: QueuedPromptProtectedClassification;
}): Promise<QueuedPromptProtectedContent> {
  const content = await decryptProtectedContent({
    componentKey: input.componentKey,
    encrypted: input.encrypted,
    envelopeSchema: encryptedQueuedPromptProtectedContentSchema,
    contentSchema: queuedPromptProtectedContentSchema,
    associatedData: queuedPromptContentAssociatedData(input),
    maximumBytes: QUEUED_PROMPT_PROTECTED_CONTENT_BYTES_LIMIT,
  });
  requireMatchingClassification(
    queuedPromptProtectedClassificationSchema,
    content.classification,
    input.publicClassification,
  );
  return content;
}

export async function encryptInteractionRequestContent(input: {
  ownerId: string;
  requestKey: string;
  keyRevision: number;
  componentKey: Uint8Array;
  content: InteractionRequestProtectedContent;
}): Promise<EncryptedInteractionRequestContent> {
  return encryptProtectedContent({
    componentKey: input.componentKey,
    content: input.content,
    contentSchema: interactionRequestProtectedContentSchema,
    envelopeSchema: encryptedInteractionRequestContentSchema,
    associatedData: interactionRequestContentAssociatedData(input),
    maximumBytes: INTERACTION_PROTECTED_CONTENT_BYTES_LIMIT,
  });
}

export async function decryptInteractionRequestContent(input: {
  ownerId: string;
  requestKey: string;
  keyRevision: number;
  componentKey: Uint8Array;
  encrypted: EncryptedInteractionRequestContent;
  publicClassification: InteractionProtectedClassification;
}): Promise<InteractionRequestProtectedContent> {
  const content = await decryptProtectedContent({
    componentKey: input.componentKey,
    encrypted: input.encrypted,
    envelopeSchema: encryptedInteractionRequestContentSchema,
    contentSchema: interactionRequestProtectedContentSchema,
    associatedData: interactionRequestContentAssociatedData(input),
    maximumBytes: INTERACTION_PROTECTED_CONTENT_BYTES_LIMIT,
  });
  requireMatchingClassification(
    interactionProtectedClassificationSchema,
    content.classification,
    input.publicClassification,
  );
  return content;
}

export async function encryptInteractionResponseContent(input: {
  ownerId: string;
  requestKey: string;
  keyRevision: number;
  componentKey: Uint8Array;
  content: InteractionResponseProtectedContent;
}): Promise<EncryptedInteractionResponseContent> {
  return encryptProtectedContent({
    componentKey: input.componentKey,
    content: input.content,
    contentSchema: interactionResponseProtectedContentSchema,
    envelopeSchema: encryptedInteractionResponseContentSchema,
    associatedData: interactionResponseContentAssociatedData(input),
    maximumBytes: INTERACTION_PROTECTED_CONTENT_BYTES_LIMIT,
  });
}

export async function decryptInteractionResponseContent(input: {
  ownerId: string;
  requestKey: string;
  keyRevision: number;
  componentKey: Uint8Array;
  encrypted: EncryptedInteractionResponseContent;
  publicClassification: InteractionProtectedClassification;
}): Promise<InteractionResponseProtectedContent> {
  const content = await decryptProtectedContent({
    componentKey: input.componentKey,
    encrypted: input.encrypted,
    envelopeSchema: encryptedInteractionResponseContentSchema,
    contentSchema: interactionResponseProtectedContentSchema,
    associatedData: interactionResponseContentAssociatedData(input),
    maximumBytes: INTERACTION_PROTECTED_CONTENT_BYTES_LIMIT,
  });
  requireMatchingClassification(
    interactionProtectedClassificationSchema,
    content.classification,
    input.publicClassification,
  );
  return content;
}
