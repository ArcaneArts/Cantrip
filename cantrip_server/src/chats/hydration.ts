import { createHash } from "node:crypto";

import {
  chatRelocationHydrationBeginResultSchema,
  chatRelocationHydrationResultSchema,
  mentionedSkillNames,
  type ChatRelocationContextPayload,
  type McpServerOpaqueRuntime,
  type PlanMode,
} from "@cantrip/protocol";

import type { ModelRuntime } from "../db/repository.js";
import type { WorkerCommandBus } from "../workers/bridge.js";

const HYDRATION_CHUNK_BYTES = 256 * 1_024;
const HYDRATION_REQUEST_TIMEOUT_MS = 30_000;
export const CANONICAL_CHAT_HYDRATION_TIMEOUT_MS = 30 * 60_000;

export class CanonicalChatHydrationError extends Error {
  constructor(
    readonly code: "digest-mismatch" | "target-mismatch" | "too-many-skills",
    message: string,
  ) {
    super(message);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function encodeCanonicalChatPayload(
  payload: ChatRelocationContextPayload,
): Buffer {
  return Buffer.from(canonicalJson(payload), "utf8");
}

export function requiredSkillsForCanonicalPayload(
  payload: ChatRelocationContextPayload,
): string[] {
  if (payload.kind !== "visible") return [];
  const names = new Set<string>();
  for (const message of payload.messages) {
    for (const item of message.content) {
      if (item.type !== "text") continue;
      for (const name of mentionedSkillNames(item.text)) names.add(name);
    }
  }
  if (names.size > 64) {
    throw new CanonicalChatHydrationError(
      "too-many-skills",
      "The canonical transcript references more than 64 skills and cannot be hydrated safely.",
    );
  }
  return [...names].sort();
}

export async function hydrateCanonicalChat(input: {
  bridge: WorkerCommandBus;
  chatId: string;
  cwd: string;
  expectedSha256?: string;
  mcpServers: McpServerOpaqueRuntime[];
  payload: ChatRelocationContextPayload;
  permissionProfileId: string;
  planMode: PlanMode;
  runtime: ModelRuntime;
  snapshotId: string;
  workerId: string;
}): Promise<{ threadId: string; transcriptSha256: string }> {
  const bytes = encodeCanonicalChatPayload(input.payload);
  const transcriptSha256 = createHash("sha256").update(bytes).digest("hex");
  if (input.expectedSha256 && input.expectedSha256 !== transcriptSha256) {
    throw new CanonicalChatHydrationError(
      "digest-mismatch",
      "The immutable canonical transcript failed server-side digest verification.",
    );
  }
  const begin = chatRelocationHydrationBeginResultSchema.parse(
    await input.bridge.request(
      input.workerId,
      {
        type: "chat.relocation.hydration.begin",
        chatId: input.chatId,
        snapshotId: input.snapshotId,
        transcriptSha256,
        sizeBytes: bytes.byteLength,
        cwd: input.cwd,
        requiredSkillNames: requiredSkillsForCanonicalPayload(input.payload),
        planMode: input.planMode,
        model: input.runtime.model,
        provider: input.runtime.provider,
        permissionProfileId: input.permissionProfileId,
        mcpServers: input.mcpServers,
      },
      { timeoutMs: HYDRATION_REQUEST_TIMEOUT_MS },
    ),
  );
  if (begin.status === "hydrated") {
    return { threadId: begin.threadId, transcriptSha256 };
  }
  for (
    let offset = 0, chunkIndex = 0;
    offset < bytes.byteLength;
    offset += HYDRATION_CHUNK_BYTES, chunkIndex += 1
  ) {
    await input.bridge.request(
      input.workerId,
      {
        type: "chat.relocation.hydration.chunk",
        snapshotId: input.snapshotId,
        chunkIndex,
        data: bytes
          .subarray(offset, offset + HYDRATION_CHUNK_BYTES)
          .toString("base64"),
      },
      { timeoutMs: HYDRATION_REQUEST_TIMEOUT_MS },
    );
  }
  const hydrated = chatRelocationHydrationResultSchema.parse(
    await input.bridge.request(
      input.workerId,
      {
        type: "chat.relocation.hydration.complete",
        snapshotId: input.snapshotId,
      },
      { timeoutMs: CANONICAL_CHAT_HYDRATION_TIMEOUT_MS },
    ),
  );
  if (
    hydrated.snapshotId !== input.snapshotId ||
    hydrated.transcriptSha256 !== transcriptSha256
  ) {
    throw new CanonicalChatHydrationError(
      "target-mismatch",
      "The target worker returned hydration state for a different snapshot.",
    );
  }
  return { threadId: hydrated.threadId, transcriptSha256 };
}
