import {
  encryptedTaskGoalObjectiveSchema,
  encryptedTaskMessageProtectedContentSchema,
  encryptedTaskPlanningRoundProtectedContentSchema,
  encryptedTaskProtectedContentSchema,
  taskGoalObjectiveProtectedClassificationSchema,
  taskGoalObjectiveProtectedContentSchema,
  taskMessageProtectedClassificationSchema,
  taskMessageProtectedContentSchema,
  taskPlanningRoundProtectedClassificationSchema,
  taskPlanningRoundProtectedContentSchema,
  taskProtectedClassificationSchema,
  taskProtectedContentSchema,
  TASK_GOAL_OBJECTIVE_PROTECTED_CONTENT_BYTES_LIMIT,
  TASK_MESSAGE_PROTECTED_CONTENT_BYTES_LIMIT,
  TASK_PLANNING_ROUND_PROTECTED_CONTENT_BYTES_LIMIT,
  TASK_PROTECTED_CONTENT_BYTES_LIMIT,
  type EncryptedTaskGoalObjective,
  type EncryptedTaskMessageProtectedContent,
  type EncryptedTaskPlanningRoundProtectedContent,
  type EncryptedTaskProtectedContent,
  type TaskGoalObjectiveProtectedClassification,
  type TaskGoalObjectiveProtectedContent,
  type TaskMessageProtectedClassification,
  type TaskMessageProtectedContent,
  type TaskPlanningRoundProtectedClassification,
  type TaskPlanningRoundProtectedContent,
  type TaskProtectedClassification,
  type TaskProtectedContent,
} from "@cantrip/protocol/tasks";
import {
  encryptionAssociatedDataSchema,
  type EncryptedPayloadEnvelope,
  type EncryptionAssociatedData,
} from "@cantrip/protocol/encryption";

import { clearSensitiveBytes } from "./bytes.js";
import { deriveFieldKey } from "./kdf.js";
import {
  CantripDecryptionError,
  decryptPayload,
  encryptPayload,
} from "./payload.js";

const component = "task-content" as const;
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

function associatedData(input: {
  ownerId: string;
  table: string;
  rowId: string;
  field: string;
  keyRevision: number;
}): EncryptionAssociatedData {
  return encryptionAssociatedDataSchema.parse({
    ownerId: input.ownerId,
    component,
    table: input.table,
    rowId: input.rowId,
    field: input.field,
    formatVersion,
    keyRevision: input.keyRevision,
  });
}

export function taskContentAssociatedData(input: {
  ownerId: string;
  chatId: string;
  keyRevision: number;
}): EncryptionAssociatedData {
  return associatedData({
    ownerId: input.ownerId,
    table: "tasks",
    rowId: input.chatId,
    field: "protected_content",
    keyRevision: input.keyRevision,
  });
}

export function taskPlanningRoundContentAssociatedData(input: {
  ownerId: string;
  roundId: string;
  keyRevision: number;
}): EncryptionAssociatedData {
  return associatedData({
    ownerId: input.ownerId,
    table: "task_planning_rounds",
    rowId: input.roundId,
    field: "protected_content",
    keyRevision: input.keyRevision,
  });
}

export function taskMessageContentAssociatedData(input: {
  ownerId: string;
  messageId: string;
  keyRevision: number;
}): EncryptionAssociatedData {
  return associatedData({
    ownerId: input.ownerId,
    table: "chat_messages",
    rowId: input.messageId,
    field: "task_protected_content",
    keyRevision: input.keyRevision,
  });
}

export function taskGoalObjectiveAssociatedData(input: {
  ownerId: string;
  chatId: string;
  threadId: string;
  keyRevision: number;
}): EncryptionAssociatedData {
  return associatedData({
    ownerId: input.ownerId,
    table: "task_goal_snapshots",
    rowId: JSON.stringify([input.chatId, input.threadId]),
    field: "objective",
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
    throw new Error("Protected Task content exceeds its encoded byte limit.");
  }
  return plaintext;
}

function decodeProtectedContent<T>(
  schema: Parser<T>,
  plaintext: Uint8Array,
  maximumBytes: number,
): T {
  if (plaintext.byteLength > maximumBytes) {
    throw new CantripDecryptionError();
  }
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
    component,
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
    component,
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

export async function encryptTaskProtectedContent(input: {
  ownerId: string;
  chatId: string;
  keyRevision: number;
  componentKey: Uint8Array;
  content: TaskProtectedContent;
}): Promise<EncryptedTaskProtectedContent> {
  return encryptProtectedContent({
    componentKey: input.componentKey,
    content: input.content,
    contentSchema: taskProtectedContentSchema,
    envelopeSchema: encryptedTaskProtectedContentSchema,
    associatedData: taskContentAssociatedData(input),
    maximumBytes: TASK_PROTECTED_CONTENT_BYTES_LIMIT,
  });
}

export async function decryptTaskProtectedContent(input: {
  ownerId: string;
  chatId: string;
  keyRevision: number;
  componentKey: Uint8Array;
  encrypted: EncryptedTaskProtectedContent;
  publicClassification: TaskProtectedClassification;
}): Promise<TaskProtectedContent> {
  const content = await decryptProtectedContent({
    componentKey: input.componentKey,
    encrypted: input.encrypted,
    envelopeSchema: encryptedTaskProtectedContentSchema,
    contentSchema: taskProtectedContentSchema,
    associatedData: taskContentAssociatedData(input),
    maximumBytes: TASK_PROTECTED_CONTENT_BYTES_LIMIT,
  });
  requireMatchingClassification(
    taskProtectedClassificationSchema,
    content.classification,
    input.publicClassification,
  );
  return content;
}

export async function encryptTaskPlanningRoundProtectedContent(input: {
  ownerId: string;
  roundId: string;
  keyRevision: number;
  componentKey: Uint8Array;
  content: TaskPlanningRoundProtectedContent;
}): Promise<EncryptedTaskPlanningRoundProtectedContent> {
  return encryptProtectedContent({
    componentKey: input.componentKey,
    content: input.content,
    contentSchema: taskPlanningRoundProtectedContentSchema,
    envelopeSchema: encryptedTaskPlanningRoundProtectedContentSchema,
    associatedData: taskPlanningRoundContentAssociatedData(input),
    maximumBytes: TASK_PLANNING_ROUND_PROTECTED_CONTENT_BYTES_LIMIT,
  });
}

export async function decryptTaskPlanningRoundProtectedContent(input: {
  ownerId: string;
  roundId: string;
  keyRevision: number;
  componentKey: Uint8Array;
  encrypted: EncryptedTaskPlanningRoundProtectedContent;
  publicClassification: TaskPlanningRoundProtectedClassification;
}): Promise<TaskPlanningRoundProtectedContent> {
  const content = await decryptProtectedContent({
    componentKey: input.componentKey,
    encrypted: input.encrypted,
    envelopeSchema: encryptedTaskPlanningRoundProtectedContentSchema,
    contentSchema: taskPlanningRoundProtectedContentSchema,
    associatedData: taskPlanningRoundContentAssociatedData(input),
    maximumBytes: TASK_PLANNING_ROUND_PROTECTED_CONTENT_BYTES_LIMIT,
  });
  requireMatchingClassification(
    taskPlanningRoundProtectedClassificationSchema,
    content.classification,
    input.publicClassification,
  );
  return content;
}

export async function encryptTaskMessageProtectedContent(input: {
  ownerId: string;
  messageId: string;
  keyRevision: number;
  componentKey: Uint8Array;
  content: TaskMessageProtectedContent;
}): Promise<EncryptedTaskMessageProtectedContent> {
  return encryptProtectedContent({
    componentKey: input.componentKey,
    content: input.content,
    contentSchema: taskMessageProtectedContentSchema,
    envelopeSchema: encryptedTaskMessageProtectedContentSchema,
    associatedData: taskMessageContentAssociatedData(input),
    maximumBytes: TASK_MESSAGE_PROTECTED_CONTENT_BYTES_LIMIT,
  });
}

export async function decryptTaskMessageProtectedContent(input: {
  ownerId: string;
  messageId: string;
  keyRevision: number;
  componentKey: Uint8Array;
  encrypted: EncryptedTaskMessageProtectedContent;
  publicClassification: TaskMessageProtectedClassification;
}): Promise<TaskMessageProtectedContent> {
  const content = await decryptProtectedContent({
    componentKey: input.componentKey,
    encrypted: input.encrypted,
    envelopeSchema: encryptedTaskMessageProtectedContentSchema,
    contentSchema: taskMessageProtectedContentSchema,
    associatedData: taskMessageContentAssociatedData(input),
    maximumBytes: TASK_MESSAGE_PROTECTED_CONTENT_BYTES_LIMIT,
  });
  requireMatchingClassification(
    taskMessageProtectedClassificationSchema,
    content.classification,
    input.publicClassification,
  );
  return content;
}

export async function encryptTaskGoalObjective(input: {
  ownerId: string;
  chatId: string;
  threadId: string;
  keyRevision: number;
  componentKey: Uint8Array;
  content: TaskGoalObjectiveProtectedContent;
}): Promise<EncryptedTaskGoalObjective> {
  return encryptProtectedContent({
    componentKey: input.componentKey,
    content: input.content,
    contentSchema: taskGoalObjectiveProtectedContentSchema,
    envelopeSchema: encryptedTaskGoalObjectiveSchema,
    associatedData: taskGoalObjectiveAssociatedData(input),
    maximumBytes: TASK_GOAL_OBJECTIVE_PROTECTED_CONTENT_BYTES_LIMIT,
  });
}

export async function decryptTaskGoalObjective(input: {
  ownerId: string;
  chatId: string;
  threadId: string;
  keyRevision: number;
  componentKey: Uint8Array;
  encrypted: EncryptedTaskGoalObjective;
  publicClassification: TaskGoalObjectiveProtectedClassification;
}): Promise<TaskGoalObjectiveProtectedContent> {
  const content = await decryptProtectedContent({
    componentKey: input.componentKey,
    encrypted: input.encrypted,
    envelopeSchema: encryptedTaskGoalObjectiveSchema,
    contentSchema: taskGoalObjectiveProtectedContentSchema,
    associatedData: taskGoalObjectiveAssociatedData(input),
    maximumBytes: TASK_GOAL_OBJECTIVE_PROTECTED_CONTENT_BYTES_LIMIT,
  });
  requireMatchingClassification(
    taskGoalObjectiveProtectedClassificationSchema,
    content.classification,
    input.publicClassification,
  );
  return content;
}
