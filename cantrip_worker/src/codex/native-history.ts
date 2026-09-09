import { z } from "zod";

const nativeSequence = z
  .string()
  .max(20)
  .regex(/^(0|[1-9][0-9]*)$/u)
  .refine(
    (value) =>
      /^[0-9]{1,20}$/u.test(value) &&
      BigInt(value) <= 18_446_744_073_709_551_615n,
    "Native history sequence exceeds u64.",
  );
export const nativeHistoryCursorSchema = z
  .object({
    epoch: z.string().min(1),
    sequence: nativeSequence,
    previousSequence: nativeSequence.nullable(),
  })
  .strict();
export type NativeHistoryCursor = z.infer<typeof nativeHistoryCursorSchema>;

// This is worker-local source material for future protected ingestion. Do not
// add it to AgentThreadSync or return it through the existing chat.sync route.
const nativeItemSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
  })
  .passthrough();

const nativeTurnSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(["inProgress", "completed", "failed", "interrupted"]),
    items: z.array(nativeItemSchema),
    itemsView: z.enum(["notLoaded", "summary", "full"]).optional(),
    startedAt: z.number().nullable().optional(),
    completedAt: z.number().nullable().optional(),
    durationMs: z.number().nullable().optional(),
  })
  .passthrough();

const tokenUsageSchema = z
  .object({
    totalTokens: z.number(),
    inputTokens: z.number(),
    cachedInputTokens: z.number(),
    cacheWriteInputTokens: z.number(),
    outputTokens: z.number(),
    reasoningOutputTokens: z.number(),
  })
  .passthrough();

const nativeTurnErrorSchema = z
  .object({
    message: z.string(),
    codexErrorInfo: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .nullable(),
    additionalDetails: z.string().nullable(),
    misalignment: z.record(z.string(), z.unknown()).nullable(),
  })
  .passthrough();

/** Exact retained native turn settings, never synthesized from current chat defaults.
 * Multiple entries preserve context changes during compaction; no entry is a claim
 * that the entire turn used the thread's latest cwd/mode. */
export const nativeHistoryTurnContextSchema = z
  .object({
    cwd: z.string().min(1),
    model: z.string().min(1),
    collaborationMode: z.string().min(1).nullable(),
    reasoningEffort: z.string().min(1).nullable(),
    rootTurnId: z.string().min(1).nullable(),
  })
  .passthrough();

const historyMetadataSchema = z
  .object({
    version: z.literal(1),
    currentTurnId: z.string().min(1).nullable(),
    currentTurnState: z.enum(["live", "notLoaded"]),
    live: z
      .object({
        epoch: z.string().min(1),
        throughSequence: nativeSequence,
        items: z.array(
          z
            .object({
              turnId: z.string().min(1),
              item: nativeItemSchema,
              state: z.enum(["started", "completed"]),
              cursor: nativeHistoryCursorSchema,
              startedAtMs: z.number().nullable(),
              completedAtMs: z.number().nullable(),
            })
            .strict(),
        ),
      })
      .strict()
      .superRefine((live, context) => {
        for (const item of live.items)
          if (
            item.cursor.epoch !== live.epoch ||
            (nativeSequence.safeParse(item.cursor.sequence).success &&
              nativeSequence.safeParse(live.throughSequence).success &&
              BigInt(item.cursor.sequence) > BigInt(live.throughSequence))
          )
            context.addIssue({
              code: "custom",
              message:
                "Live history item is outside its native snapshot boundary.",
            });
      })
      .optional(),
    turns: z.array(
      z
        .object({
          turnId: z.string().min(1),
          source: z.enum(["canonical", "legacy"]),
          retention: z.enum(["complete", "partial", "unavailable"]),
          // Older bundles omit this. Preserve that distinction from retained evidence.
          contexts: z.array(nativeHistoryTurnContextSchema).optional(),
          items: z.array(
            z
              .object({
                itemId: z.string().min(1),
                state: z.enum(["started", "completed", "unknown"]),
                startedAtMs: z.number().nullable(),
                completedAtMs: z.number().nullable(),
              })
              .passthrough(),
          ),
          usage: z
            .object({
              responses: z.array(
                z
                  .object({
                    responseId: z.string().min(1),
                    threadId: z.string().min(1),
                    sessionId: z.string().min(1),
                    rootTurnId: z.string().min(1),
                    usage: tokenUsageSchema,
                  })
                  .passthrough(),
              ),
              total: tokenUsageSchema.nullable(),
              conflictingResponseIds: z.array(z.string()),
            })
            .passthrough()
            .nullable(),
          warnings: z.array(z.string()).nullable(),
          errors: z.array(nativeTurnErrorSchema).nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const nativeHistorySchema = z
  .object({
    thread: z
      .object({
        id: z.string().min(1),
        forkedFromId: z.string().nullable().optional(),
        parentThreadId: z.string().nullable().optional(),
        status: z.object({ type: z.string().min(1) }).passthrough(),
        turns: z.array(nativeTurnSchema),
      })
      .passthrough(),
    history: historyMetadataSchema.nullable().optional(),
  })
  .passthrough();

export type CodexNativeHistoryItem = z.infer<typeof nativeItemSchema>;
export type CodexNativeHistorySnapshot = z.infer<typeof nativeHistorySchema> & {
  history: z.infer<typeof historyMetadataSchema> | null;
};

export function parseCodexNativeHistory(
  value: unknown,
  expectedThreadId: string,
): CodexNativeHistorySnapshot {
  const parsed = nativeHistorySchema.parse(value);
  if (parsed.thread.id !== expectedThreadId)
    throw new Error("Native history belongs to a different thread.");
  // Unknown metadata is not a canonical-ID claim or measured zero usage.
  return { ...parsed, history: parsed.history ?? null };
}

const userMessageSchema = z
  .object({
    type: z.literal("userMessage"),
    id: z.string().min(1),
    clientId: z.string().nullable().optional(),
    content: z.array(z.object({ type: z.string().min(1) }).passthrough()),
  })
  .passthrough();

/** Exact user vector, including attachment-only messages and unknown future inputs. */
export function nativeHistoryUserMessage(item: CodexNativeHistoryItem) {
  return item.type === "userMessage" ? userMessageSchema.parse(item) : null;
}

type HistoryRequest = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

function unsupportedMetadata(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const native = (
    error as Error & { nativeError?: { code?: number; message?: string } }
  ).nativeError;
  return (
    native?.code === -32602 &&
    /(?:unknown|unrecognized|unsupported)\s+(?:field|parameter)/iu.test(
      native.message ?? "",
    ) &&
    /includeHistoryMetadata|include_history_metadata/u.test(
      native.message ?? "",
    )
  );
}

/** Observes the actual existing native transport. Never loads/configures a thread. */
export async function readCodexNativeHistory(
  request: HistoryRequest,
  threadId: string,
): Promise<CodexNativeHistorySnapshot> {
  let response: unknown;
  try {
    response = await request("thread/read", {
      threadId,
      includeTurns: true,
      includeHistoryMetadata: true,
    });
  } catch (error) {
    if (!unsupportedMetadata(error)) throw error;
    response = await request("thread/read", { threadId, includeTurns: true });
  }
  return parseCodexNativeHistory(response, threadId);
}
