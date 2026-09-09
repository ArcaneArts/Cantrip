import type { ManagedNativeOperation } from "./codex/managed-native-gateway.js";
import type { ChatAttachmentOpaqueSummary } from "@cantrip/protocol/attachment-content";
import {
  managedQueueText,
  managedQueuePlanPrefix,
} from "./codex/managed-queue-text.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import {
  clearSensitiveBytes,
  decryptPayload,
  decryptChatMessageProtectedContent,
  decryptQueuedPromptProtectedContent,
  deriveFieldKey,
  encryptPayload,
  encryptChatMessageProtectedContent,
  encryptQueuedPromptProtectedContent,
} from "@cantrip/crypto";
import type {
  ChatTurnMode,
  EncryptedQueuedPrompt,
  ReasoningEffort,
} from "@cantrip/protocol";
import {
  queuedPromptOpaqueContentSchema,
  type QueuedPromptOpaqueContent,
  type ChatMessageOpaqueContent,
} from "@cantrip/protocol/communication-content";
import {
  encryptionAssociatedDataSchema,
  type EncryptedPayloadEnvelope,
} from "@cantrip/protocol/encryption";
import { z } from "zod";
import { protectChatTurn } from "./chat-message-encryption.js";
import type {
  ManagedNativeQueuePromptInput,
  ManagedNativeQueuePreparedPrompt,
  ManagedNativeQueuedSubmission,
} from "./codex/managed-native-queue.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";
import type { AttachmentStore } from "./attachment-store.js";
import { projectManagedQueueMedia } from "./managed-queue-media.js";
import { openWorkerAttachments } from "./attachment-encryption.js";

const detail = z
  .enum(["auto", "low", "high", "original"])
  .nullable()
  .optional();
const textElement = z
  .object({
    byteRange: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
      })
      .strict(),
    placeholder: z.string().nullable().optional(),
  })
  .strict();
/** Pinned app-server UserInput, including native snake-case text_elements. */
export const nativeQueueUserInputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: z.string(),
      text_elements: z.array(textElement).optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("image"), url: z.string().min(1), detail })
    .strict(),
  z
    .object({ type: z.literal("localImage"), path: z.string().min(1), detail })
    .strict(),
  z.object({ type: z.literal("audio"), url: z.string().min(1) }).strict(),
  z.object({ type: z.literal("localAudio"), path: z.string().min(1) }).strict(),
  z
    .object({ type: z.literal("skill"), name: z.string(), path: z.string() })
    .strict(),
  z
    .object({ type: z.literal("mention"), name: z.string(), path: z.string() })
    .strict(),
]);
export type NativeQueueUserInput = z.infer<typeof nativeQueueUserInputSchema>;
const actionSchema = z.enum(["plain", "literal", "parseSlash", "runShell"]);
const methodSchema = z.enum([
  "turn/start",
  "thread/goal/set",
  "thread/goal/clear",
  "thread/settings/update",
  "thread/shellCommand",
]);
const envelopeContent = z
  .object({
    version: z.literal(1),
    input: z.array(nativeQueueUserInputSchema).min(1),
    displayText: z.string(),
    action: actionSchema,
    executionMethod: methodSchema,
    retainedGui: z.boolean().optional(),
    retainedTurnStart: z.boolean().optional(),
    representedAttachmentIds: z.array(z.string()).optional(),
    attachmentMap: z
      .array(
        z
          .object({ id: z.string(), index: z.number().int().nonnegative() })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type ManagedQueueNativeInput = z.infer<typeof envelopeContent>;
export interface ManagedQueueInputDefaults {
  mode: ChatTurnMode;
  modelId: string;
  reasoningEffort: ReasoningEffort | null;
  customSubagentModel?: boolean;
  subagentModelId?: string | null;
  subagentReasoningEffort?: ReasoningEffort | null;
  worktreeId?: string | null;
}
export interface ManagedQueueInputCodecOptions {
  encryption: WorkerEncryptionService;
  chatId: string;
  defaults(): ManagedQueueInputDefaults;
  openAttachments?(
    prompt: EncryptedQueuedPrompt,
  ): Promise<NativeQueueUserInput[]>;
  attachmentStore?: AttachmentStore;
}
function stableId(...parts: string[]): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function material(
  options: ManagedQueueInputCodecOptions,
  promptId: string,
  revision?: number,
) {
  const component = options.encryption.componentKey("chat-content", revision);
  try {
    const associatedData = encryptionAssociatedDataSchema.parse({
      ownerId: options.encryption.ownerId(),
      component: "chat-content",
      table: "managed-queue",
      rowId: createHash("sha256")
        .update(
          JSON.stringify([
            options.encryption.serverIdentity(),
            options.chatId,
            promptId,
          ]),
        )
        .digest("hex"),
      field: "native-input",
      formatVersion: 1,
      keyRevision: component.keyRevision,
    });
    return {
      associatedData,
      key: deriveFieldKey({
        componentKey: component.key,
        ownerId: associatedData.ownerId,
        component: associatedData.component,
        table: associatedData.table,
        field: associatedData.field,
        keyRevision: associatedData.keyRevision,
      }),
    };
  } finally {
    clearSensitiveBytes(component.key);
  }
}
const mimeTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".aiff": "audio/aiff",
  ".webm": "audio/webm",
};
async function portableInput(
  input: NativeQueueUserInput[],
): Promise<NativeQueueUserInput[]> {
  return Promise.all(
    input.map(async (item) => {
      if (item.type !== "localImage" && item.type !== "localAudio") return item;
      // Read the actual source before accepting the queue entry. Later execution
      // must not depend on a transient file or a replacement file at the same path.
      const bytes = await readFile(item.path);
      try {
        const url = `data:${mimeTypes[extname(item.path).toLowerCase()] ?? "application/octet-stream"};base64,${bytes.toString("base64")}`;
        return item.type === "localImage"
          ? { type: "image" as const, url, detail: item.detail }
          : { type: "audio" as const, url };
      } finally {
        bytes.fill(0);
      }
    }),
  );
}
function displayText(
  input: NativeQueueUserInput[],
  attachmentMap: ManagedQueueNativeInput["attachmentMap"] = [],
): string {
  const represented = new Set(attachmentMap.map((item) => item.index));
  const text = input
    .flatMap((item, index) =>
      item.type === "text" && !represented.has(index) ? [item.text] : [],
    )
    .join("\n")
    .trim();
  if (text) return text;
  return input
    .map((item) => {
      switch (item.type) {
        case "image":
        case "localImage":
          return "[Queued image]";
        case "audio":
        case "localAudio":
          return "[Queued audio]";
        case "skill":
          return `[Skill: ${item.name}]`;
        case "mention":
          return `[Mention: ${item.name}]`;
        case "text":
          return "";
      }
    })
    .filter(Boolean)
    .join("\n");
}
function classify(
  action: z.infer<typeof actionSchema>,
  input: NativeQueueUserInput[],
  mode: ChatTurnMode,
) {
  const text = managedQueueText(input);
  if (action === "plain" && text.startsWith("!")) action = "runShell";
  if (action === "runShell")
    return {
      action,
      mode: "default" as const,
      executionMethod: "thread/shellCommand" as const,
    };
  if (action === "parseSlash") {
    const plan = managedQueuePlanPrefix(input);
    if (plan)
      return {
        action,
        mode: "plan" as const,
        executionMethod: plan.hasInput
          ? ("turn/start" as const)
          : ("thread/settings/update" as const),
      };
    if (/^\/goal(?:\s|$)/u.test(text)) {
      const argument = text.slice(5).trim().toLowerCase();
      if (!argument || argument === "edit")
        throw new Error(
          "This goal command opens an interactive CLI view. Run it directly; the queued draft was not dispatched.",
        );
      return {
        action,
        mode: "goal" as const,
        executionMethod:
          argument === "clear"
            ? ("thread/goal/clear" as const)
            : ("thread/goal/set" as const),
      };
    }
    // Unsupported commands remain editable; they are never submitted as prose.
    throw new Error(
      "This queued slash command has no managed execution mapping yet. Edit the queued command or run it directly in the CLI.",
    );
  }
  return {
    action,
    mode,
    executionMethod:
      mode === "goal" ? ("thread/goal/set" as const) : ("turn/start" as const),
  };
}

export function createManagedQueueInputCodec(
  options: ManagedQueueInputCodecOptions,
) {
  async function protectNativeInput(
    promptId: string,
    content: ManagedQueueNativeInput,
  ): Promise<EncryptedPayloadEnvelope> {
    const { key, associatedData } = material(options, promptId);
    const plaintext = new TextEncoder().encode(
      JSON.stringify(envelopeContent.parse(content)),
    );
    try {
      return await encryptPayload({ key, associatedData, plaintext });
    } finally {
      clearSensitiveBytes(plaintext);
      clearSensitiveBytes(key);
    }
  }
  async function openNativeInput(input: {
    promptId: string;
    payload: EncryptedPayloadEnvelope;
    text?: string;
    attachmentIds?: string[];
  }): Promise<ManagedQueueNativeInput> {
    const { key, associatedData } = material(
      options,
      input.promptId,
      input.payload.keyRevision,
    );
    try {
      const plaintext = await decryptPayload({
        key,
        associatedData,
        envelope: input.payload,
      });
      try {
        const opened = envelopeContent.parse(
          JSON.parse(new TextDecoder().decode(plaintext)),
        );
        const textChanged =
          input.text !== undefined && input.text !== opened.displayText;
        if (
          opened.retainedGui &&
          (textChanged ||
            (input.attachmentIds !== undefined &&
              JSON.stringify(input.attachmentIds) !==
                JSON.stringify(opened.representedAttachmentIds ?? [])))
        ) {
          // The exact rejected vector can include attachment metadata folded into
          // text. After an edit, rebuild from the canonical user text and let the
          // existing attachment projection add only the current selection.
          return {
            ...opened,
            retainedGui: false,
            representedAttachmentIds: [],
            attachmentMap: [],
            displayText: input.text ?? opened.displayText,
            input: [
              {
                type: "text",
                text: input.text ?? opened.displayText,
                text_elements: [],
              },
            ],
          };
        }
        const keptIds = input.attachmentIds && new Set(input.attachmentIds);
        const byIndex = new Map(
          opened.attachmentMap.map((entry) => [entry.index, entry]),
        );
        const replaced: NativeQueueUserInput[] = [];
        const attachmentMap: ManagedQueueNativeInput["attachmentMap"] = [];
        let wroteText = false;
        for (const [index, item] of opened.input.entries()) {
          const attachment = byIndex.get(index);
          if (attachment && keptIds && !keptIds.has(attachment.id)) continue;
          if (textChanged && item.type === "text" && !attachment) {
            if (!wroteText)
              replaced.push({
                type: "text",
                text: input.text!,
                text_elements: [],
              });
            wroteText = true;
            continue;
          }
          if (attachment)
            attachmentMap.push({ ...attachment, index: replaced.length });
          replaced.push(item);
        }
        if (textChanged && !wroteText && input.text!.length) {
          replaced.unshift({
            type: "text",
            text: input.text!,
            text_elements: [],
          });
          for (const entry of attachmentMap) entry.index++;
        }
        return {
          ...opened,
          input: replaced,
          attachmentMap,
          displayText: input.text ?? opened.displayText,
        };
      } finally {
        clearSensitiveBytes(plaintext);
      }
    } finally {
      clearSensitiveBytes(key);
    }
  }
  async function openDisplay(
    prompt: QueuedPromptOpaqueContent | EncryptedQueuedPrompt,
  ) {
    if ("chatId" in prompt && prompt.chatId !== options.chatId)
      throw new Error("The queue item belongs to another chat.");
    const component = options.encryption.componentKey(
      "chat-content",
      prompt.protectedContent.keyRevision,
    );
    try {
      return await decryptQueuedPromptProtectedContent({
        ownerId: options.encryption.ownerId(),
        componentKey: component.key,
        keyRevision: component.keyRevision,
        promptId: prompt.id,
        encrypted: prompt.protectedContent,
        publicClassification: prompt.classification,
      });
    } finally {
      clearSensitiveBytes(component.key);
    }
  }
  async function openPrompt(
    prompt: EncryptedQueuedPrompt,
  ): Promise<ManagedNativeQueuedSubmission> {
    const display = await openDisplay(prompt);
    let input: NativeQueueUserInput[];
    let action: z.infer<typeof actionSchema>;
    let representedAttachments: string[] = [];
    if (prompt.protectedNativeInput) {
      const opened = await openNativeInput({
        promptId: prompt.id,
        payload: prompt.protectedNativeInput,
        text: display.text,
        attachmentIds: prompt.classification.attachmentIds,
      });
      input = opened.input;
      action = opened.action;
      representedAttachments = [
        ...(opened.representedAttachmentIds ?? []),
        ...opened.attachmentMap.map((entry) => entry.id),
      ];
    } else {
      input = [{ type: "text", text: display.text, text_elements: [] }];
      action = prompt.nativeAction ?? "literal";
    }
    const remainingAttachments = prompt.attachments.filter(
      (attachment) => !representedAttachments.includes(attachment.id),
    );
    if (remainingAttachments.length > 0) {
      if (!options.openAttachments)
        throw new Error(
          "Native projection for these queued attachments is unavailable.",
        );
      input.push(
        ...z.array(nativeQueueUserInputSchema).parse(
          await options.openAttachments({
            ...prompt,
            attachments: remainingAttachments,
          }),
        ),
      );
    }
    return {
      id: prompt.id,
      input,
      clientUserMessageId:
        prompt.nativeClientUserMessageId ??
        `cantrip:${prompt.pendingMessage.id}`,
      managed: {
        frozen: prompt.frozen,
        mode: prompt.classification.mode,
        action,
        modelLabel: prompt.modelId,
        worktreeLabel: prompt.worktreeId,
      },
    };
  }
  async function resealDisplay(
    prompt: QueuedPromptOpaqueContent,
    mode: ChatTurnMode,
    text?: string,
  ): Promise<QueuedPromptOpaqueContent> {
    const queued = await openDisplay(prompt);
    const previous = options.encryption.componentKey(
      "chat-content",
      prompt.pendingMessage.protectedContent.keyRevision,
    );
    let message;
    try {
      message = await decryptChatMessageProtectedContent({
        ownerId: options.encryption.ownerId(),
        messageId: prompt.pendingMessage.id,
        componentKey: previous.key,
        keyRevision: previous.keyRevision,
        encrypted: prompt.pendingMessage.protectedContent,
        publicClassification: prompt.pendingMessage.classification,
      });
    } finally {
      clearSensitiveBytes(previous.key);
    }
    const component = options.encryption.componentKey("chat-content");
    const classification = { ...prompt.classification, mode };
    const messageClassification = {
      ...prompt.pendingMessage.classification,
      mode,
    };
    try {
      return queuedPromptOpaqueContentSchema.parse({
        ...prompt,
        classification,
        protectedContent: await encryptQueuedPromptProtectedContent({
          ownerId: options.encryption.ownerId(),
          promptId: prompt.id,
          componentKey: component.key,
          keyRevision: component.keyRevision,
          content: { ...queued, classification, text: text ?? queued.text },
        }),
        pendingMessage: {
          ...prompt.pendingMessage,
          classification: messageClassification,
          protectedContent: await encryptChatMessageProtectedContent({
            ownerId: options.encryption.ownerId(),
            messageId: prompt.pendingMessage.id,
            componentKey: component.key,
            keyRevision: component.keyRevision,
            content: {
              ...message,
              classification: messageClassification,
              content:
                text === undefined
                  ? message.content
                  : [
                      ...(text.length ? [{ type: "text" as const, text }] : []),
                      ...message.content.filter(
                        (item) =>
                          !(
                            item &&
                            typeof item === "object" &&
                            !Array.isArray(item) &&
                            item.type === "text"
                          ),
                      ),
                    ],
            },
          }),
        },
      });
    } finally {
      clearSensitiveBytes(component.key);
    }
  }
  async function normalizePrompt(
    prompt: QueuedPromptOpaqueContent,
  ): Promise<QueuedPromptOpaqueContent> {
    if (!prompt.protectedNativeInput)
      return queuedPromptOpaqueContentSchema.parse({
        ...prompt,
        nativeAction: prompt.nativeAction ?? "literal",
        executionMethod:
          prompt.classification.mode === "goal"
            ? "thread/goal/set"
            : "turn/start",
      });
    const display = await openDisplay(prompt);
    const opened = await openNativeInput({
      promptId: prompt.id,
      payload: prompt.protectedNativeInput,
      text: display.text,
      attachmentIds: prompt.classification.attachmentIds,
    });
    const classification =
      opened.retainedGui || opened.retainedTurnStart
        ? {
            action: opened.action,
            mode: prompt.classification.mode,
            executionMethod: opened.executionMethod,
          }
        : classify(opened.action, opened.input, prompt.classification.mode);
    const normalized =
      classification.mode === prompt.classification.mode
        ? prompt
        : await resealDisplay(prompt, classification.mode);
    return queuedPromptOpaqueContentSchema.parse({
      ...normalized,
      nativeAction: classification.action,
      executionMethod: classification.executionMethod,
      protectedNativeInput: await protectNativeInput(prompt.id, {
        ...opened,
        action: classification.action,
        executionMethod: classification.executionMethod,
      }),
    });
  }
  async function retainGuiPrompt(input: {
    pendingMessage: ChatMessageOpaqueContent;
    attachments: ChatAttachmentOpaqueSummary[];
    input: unknown[];
    clientUserMessageId?: string;
  }): Promise<ManagedNativeQueuePreparedPrompt> {
    const message = input.pendingMessage;
    if (
      message.classification.role !== "user" ||
      (input.clientUserMessageId !== undefined &&
        input.clientUserMessageId !== message.id &&
        input.clientUserMessageId !== `cantrip:${message.id}`) ||
      JSON.stringify(message.classification.attachmentIds) !==
        JSON.stringify(input.attachments.map((item) => item.id)) ||
      input.attachments.some((item) => item.chatId !== options.chatId)
    )
      throw new Error(
        "The retained GUI input does not match its original message and attachments.",
      );
    const previous = options.encryption.componentKey(
      "chat-content",
      message.protectedContent.keyRevision,
    );
    let opened;
    try {
      opened = await decryptChatMessageProtectedContent({
        ownerId: options.encryption.ownerId(),
        messageId: message.id,
        componentKey: previous.key,
        keyRevision: previous.keyRevision,
        encrypted: message.protectedContent,
        publicClassification: message.classification,
      });
    } finally {
      clearSensitiveBytes(previous.key);
    }
    const text = opened.content
      .flatMap((item) =>
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        item.type === "text" &&
        typeof item.text === "string"
          ? [item.text]
          : [],
      )
      .join("\n");
    const id = stableId(
      "cantrip:deferred-gui",
      options.encryption.serverIdentity(),
      options.chatId,
      message.id,
    );
    const classification = {
      mode: message.classification.mode,
      attachmentIds: message.classification.attachmentIds,
    };
    const nativeInput = await portableInput(
      z.array(nativeQueueUserInputSchema).min(1).parse(input.input),
    );
    const protectedNativeInput = await protectNativeInput(id, {
      version: 1,
      input: nativeInput,
      displayText: text,
      action: "literal",
      executionMethod: "turn/start",
      attachmentMap: [],
      retainedGui: true,
      representedAttachmentIds: classification.attachmentIds,
    });
    const component = options.encryption.componentKey("chat-content");
    try {
      const defaults = options.defaults();
      const protectedContent = await encryptQueuedPromptProtectedContent({
        ownerId: options.encryption.ownerId(),
        promptId: id,
        componentKey: component.key,
        keyRevision: component.keyRevision,
        content: { version: 1, classification, text },
      });
      return {
        prompt: queuedPromptOpaqueContentSchema.parse({
          id,
          classification,
          protectedContent,
          pendingMessage: message,
          modelId: defaults.modelId,
          reasoningEffort: message.reasoningEffort,
          customSubagentModel: defaults.customSubagentModel,
          subagentModelId: defaults.subagentModelId,
          subagentReasoningEffort: defaults.subagentReasoningEffort,
          worktreeId: defaults.worktreeId ?? null,
          frozen: false,
          idempotencyKey: `deferred-gui:${message.id}`,
          protectedNativeInput,
          nativeAction: "literal",
          executionMethod: "turn/start",
          nativeClientUserMessageId: `cantrip:${message.id}`,
        }),
        attachments: input.attachments,
      };
    } finally {
      clearSensitiveBytes(component.key);
    }
  }
  async function preparePrompt(
    input: ManagedNativeQueuePromptInput,
    retainedTurnStart = false,
  ): Promise<ManagedNativeQueuePreparedPrompt> {
    const { request, existing, id } = input;
    if (existing && (existing.id !== id || existing.chatId !== options.chatId))
      throw new Error("The queue edit targets another item.");
    const parsedInput = z
      .array(nativeQueueUserInputSchema)
      .min(1)
      .parse(request.params.input);
    const nativeInput = await portableInput(parsedInput);
    const defaults = options.defaults();
    const managed =
      request.params.managed && typeof request.params.managed === "object"
        ? (request.params.managed as Record<string, unknown>)
        : {};
    const action = actionSchema.parse(
      managed.action ?? existing?.nativeAction ?? "plain",
    );
    const classification = classify(
      action,
      nativeInput,
      existing?.classification.mode ?? defaults.mode,
    );
    if (retainedTurnStart) classification.executionMethod = "turn/start";
    const retainedAttachments: EncryptedQueuedPrompt["attachments"] = [];
    const retainedMap: ManagedQueueNativeInput["attachmentMap"] = [];
    const representedIndices = new Set<number>();
    if (existing?.attachments.length) {
      const previous =
        existing.protectedNativeInput &&
        (await openNativeInput({
          promptId: id,
          payload: existing.protectedNativeInput,
        }));
      for (const attachment of existing.attachments) {
        const indices = previous
          ? previous.attachmentMap
              .filter((entry) => entry.id === attachment.id)
              .map((entry) => entry.index)
          : [];
        let projected: NativeQueueUserInput[];
        if (previous && indices.length)
          projected = indices.map((index) => previous.input[index]!);
        else {
          if (!options.openAttachments)
            throw new Error(
              "Native projection for these queued attachments is unavailable.",
            );
          projected = await portableInput(
            z.array(nativeQueueUserInputSchema).parse(
              await options.openAttachments({
                ...existing,
                attachments: [attachment],
              }),
            ),
          );
        }
        // A native edit carries the complete vector. Retain only attachments
        // still represented there, and keep their durable ID and GUI metadata.
        const start = nativeInput.findIndex(
          (_item, offset) =>
            projected.length > 0 &&
            projected.every(
              (item, index) =>
                !representedIndices.has(offset + index) &&
                JSON.stringify(nativeInput[offset + index]) ===
                  JSON.stringify(item),
            ),
        );
        if (start < 0) continue;
        retainedAttachments.push(attachment);
        for (let offset = 0; offset < projected.length; offset++) {
          representedIndices.add(start + offset);
          retainedMap.push({ id: attachment.id, index: start + offset });
        }
      }
    }
    const media = await projectManagedQueueMedia({
      input: nativeInput,
      chatId: options.chatId,
      promptId: id,
      operationId: String(managed.operationId ?? id),
      encryption: options.encryption,
      store: options.attachmentStore,
      representedIndices,
      fileNames: new Map(
        parsedInput.flatMap((item, index) =>
          item.type === "localImage" || item.type === "localAudio"
            ? [[index, item.path] as const]
            : [],
        ),
      ),
    });
    const attachmentMap = [...retainedMap, ...media.attachmentMap];
    const text = displayText(nativeInput, attachmentMap);
    const messageId =
      existing?.pendingMessage.id ??
      stableId(
        "cantrip:managed-queue-message",
        options.encryption.serverIdentity(),
        options.chatId,
        id,
      );
    const clientUserMessageId = z
      .string()
      .min(1)
      .max(255)
      .parse(
        request.params.clientUserMessageId ??
          existing?.nativeClientUserMessageId ??
          `cantrip:${messageId}`,
      );
    const turn = await protectChatTurn({
      service: options.encryption,
      promptId: id,
      messageId,
      text,
      attachments: [
        ...(await openWorkerAttachments(
          retainedAttachments,
          options.encryption,
        )),
        ...media.summaries,
      ],
      idempotencyKey: existing?.idempotencyKey ?? `managed-queue:${id}`,
      mode: classification.mode,
      modelId: existing?.modelId ?? defaults.modelId,
      reasoningEffort: existing
        ? existing.reasoningEffort
        : defaults.reasoningEffort,
      customSubagentModel:
        existing?.customSubagentModel ?? defaults.customSubagentModel,
      subagentModelId: existing
        ? existing.subagentModelId
        : defaults.subagentModelId,
      subagentReasoningEffort: existing
        ? existing.subagentReasoningEffort
        : defaults.subagentReasoningEffort,
    });
    const protectedNativeInput = await protectNativeInput(id, {
      version: 1,
      input: nativeInput,
      displayText: text,
      action: classification.action,
      executionMethod: classification.executionMethod,
      attachmentMap,
      ...(retainedTurnStart ? { retainedTurnStart: true } : {}),
    });
    return {
      prompt: queuedPromptOpaqueContentSchema.parse({
        ...turn.queuedPrompt,
        protectedNativeInput,
        nativeAction: classification.action,
        executionMethod: classification.executionMethod,
        nativeClientUserMessageId: clientUserMessageId,
        frozen: existing?.frozen ?? false,
        worktreeId: existing
          ? existing.worktreeId
          : (defaults.worktreeId ?? null),
      }),
      attachments: [...retainedAttachments, ...media.attachments],
    };
  }
  async function retainTerminalPrompt(
    operation: ManagedNativeOperation,
  ): Promise<{
    retainedPrompt: QueuedPromptOpaqueContent;
    attachments: ChatAttachmentOpaqueSummary[];
  }> {
    const params = operation.frame.params;
    if (
      operation.origin !== "terminal" ||
      operation.method !== "turn/start" ||
      operation.kind !== "start" ||
      operation.queueClaim ||
      !params ||
      typeof params !== "object" ||
      Array.isArray(params)
    )
      throw new Error(
        "Terminal retention requires an unconsumed direct native turn/start.",
      );
    const nativeParams = params as Record<string, unknown>;
    const assertOwner = () => {
      if (
        operation.identity.serverId !== options.encryption.serverIdentity() ||
        operation.identity.ownerId !== options.encryption.ownerId() ||
        operation.identity.chatId !== options.chatId ||
        (nativeParams.threadId !== undefined &&
          nativeParams.threadId !== operation.identity.threadId)
      )
        throw new Error(
          "The retained terminal input belongs to another source.",
        );
    };
    assertOwner();
    const id = stableId(
      "cantrip:deferred-terminal",
      options.encryption.serverIdentity(),
      options.chatId,
      operation.operationId,
    );
    const prepared = await preparePrompt(
      {
        id,
        request: {
          method: "thread/queue/add",
          params: {
            ...nativeParams,
            managed: { action: "literal", operationId: operation.operationId },
          },
          identity: operation.identity,
          connectionId: operation.connectionId ?? operation.operationId,
          signal: new AbortController().signal,
          assertCurrent: assertOwner,
        },
      },
      true,
    );
    assertOwner();
    return {
      retainedPrompt: prepared.prompt,
      attachments: prepared.attachments,
    };
  }
  return {
    retainTerminalPrompt,
    preparePrompt,
    retainGuiPrompt,
    openPrompt,
    openNativeInput,
    normalizePrompt,
  };
}
