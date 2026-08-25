import { createHash } from "node:crypto";

import {
  PROJECT_EXPORT_MAX_CHATS,
  projectExportChatBeginResultSchema,
  projectExportChatResultSchema,
  type ChatRelocationContextPayload,
  type PrivateDisplayLabelOpaque,
  type ProjectExportChatResult,
  type ProjectExportMapping,
  type ProjectExportTarget,
} from "@cantrip/protocol";

import type { WorkerCommandBus } from "../workers/bridge.js";
import { encodeCanonicalChatPayload } from "../chats/hydration.js";

const PROJECT_EXPORT_CHUNK_BYTES = 256 * 1_024;
const PROJECT_EXPORT_REQUEST_TIMEOUT_MS = 30_000;
const PROJECT_EXPORT_COMPLETE_TIMEOUT_MS = 5 * 60_000;

export interface ProjectExportTargetDefinition {
  kind: ProjectExportTarget["kind"];
  label: string;
  maxChats: number;
  requiredWorkerCapability: "externalCodexHistory" | null;
  supportedChatExperiences: Array<"agent" | "task">;
  preserves: ProjectExportMapping[];
  flattens: ProjectExportMapping[];
}

const TARGET_DEFINITIONS = new Map<
  ProjectExportTarget["kind"],
  ProjectExportTargetDefinition
>([
  [
    "codex-local",
    {
      kind: "codex-local",
      label: "Codex",
      maxChats: PROJECT_EXPORT_MAX_CHATS,
      requiredWorkerCapability: "externalCodexHistory",
      supportedChatExperiences: ["agent"],
      preserves: [
        {
          id: "project-folder",
          label: "Project folder",
          description:
            "The selected Cantrip worktree becomes the Codex thread workspace; project files are not copied.",
        },
        {
          id: "chat-title",
          label: "Chat titles",
          description: "Each selected chat keeps its current title.",
        },
        {
          id: "chat-messages",
          label: "Conversation",
          description:
            "User, assistant, and developer messages become native Codex thread messages.",
        },
      ],
      flattens: [
        {
          id: "activities",
          label: "Tool and agent activity",
          description:
            "Supported activity is converted to compact text annotations inside the transcript.",
        },
        {
          id: "attachments",
          label: "Attachments",
          description:
            "Attachment references are retained as text; attachment files are not copied in this first version.",
        },
        {
          id: "cantrip-metadata",
          label: "Cantrip-only state",
          description:
            "Workers, routes, credentials, tasks, schedules, approvals, goals, and managed tools are omitted.",
        },
      ],
    },
  ],
]);

export function projectExportTargetDefinition(
  target: ProjectExportTarget,
): ProjectExportTargetDefinition {
  const definition = TARGET_DEFINITIONS.get(target.kind);
  if (!definition) {
    throw new Error(`Project export target ${target.kind} is unavailable.`);
  }
  return definition;
}

export async function exportCanonicalChat(input: {
  bridge: WorkerCommandBus;
  operationId: string;
  target: ProjectExportTarget;
  workerId: string;
  chatId: string;
  cwd: string;
  titleProtection: PrivateDisplayLabelOpaque;
  payload: ChatRelocationContextPayload;
}): Promise<ProjectExportChatResult> {
  const bytes = encodeCanonicalChatPayload(input.payload);
  const transcriptSha256 = createHash("sha256").update(bytes).digest("hex");
  const begin = projectExportChatBeginResultSchema.parse(
    await input.bridge.request(
      input.workerId,
      {
        type: "project.export.chat.begin",
        operationId: input.operationId,
        target: input.target,
        chatId: input.chatId,
        cwd: input.cwd,
        titleProtection: input.titleProtection,
        transcriptSha256,
        sizeBytes: bytes.byteLength,
      },
      { timeoutMs: PROJECT_EXPORT_REQUEST_TIMEOUT_MS },
    ),
  );
  if (begin.status === "exported") {
    const { status: _status, ...result } = begin;
    return projectExportChatResultSchema.parse(result);
  }
  for (
    let offset = 0, chunkIndex = 0;
    offset < bytes.byteLength;
    offset += PROJECT_EXPORT_CHUNK_BYTES, chunkIndex += 1
  ) {
    await input.bridge.request(
      input.workerId,
      {
        type: "project.export.chat.chunk",
        operationId: input.operationId,
        chatId: input.chatId,
        chunkIndex,
        data: bytes
          .subarray(offset, offset + PROJECT_EXPORT_CHUNK_BYTES)
          .toString("base64"),
      },
      { timeoutMs: PROJECT_EXPORT_REQUEST_TIMEOUT_MS },
    );
  }
  return projectExportChatResultSchema.parse(
    await input.bridge.request(
      input.workerId,
      {
        type: "project.export.chat.complete",
        operationId: input.operationId,
        chatId: input.chatId,
      },
      { timeoutMs: PROJECT_EXPORT_COMPLETE_TIMEOUT_MS },
    ),
  );
}
