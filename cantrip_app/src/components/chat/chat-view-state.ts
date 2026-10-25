import {
  chatComposerDraftSchema,
  githubIssueSummarySchema,
  githubIssueKindSchema,
} from "@cantrip/protocol";
import type { ChatSummary } from "@cantrip/protocol";
import { z } from "zod";

const coordinate = z.number().finite().nonnegative();
/** Private renderer state; only the encrypted workspace transfer carries it. */
const chatViewStateSchema = z
  .object({
    version: z.literal(1),
    chatId: z.string().min(1),
    projectId: z.string().min(1),
    draft: chatComposerDraftSchema,
    nativeModeIntent: z.enum(["default", "plan"]).nullable(),
    composerSelection: z
      .object({
        start: coordinate.int(),
        end: coordinate.int(),
        scrollTop: coordinate,
      })
      .strict(),
    transcript: z
      .object({
        scrollTop: coordinate,
        following: z.boolean(),
        oldestSequence: coordinate.int().nullable().optional(),
      })
      .strict(),
    selectedGithubReferences: z
      .array(githubIssueSummarySchema.extend({ kind: githubIssueKindSchema }))
      .optional(),
    inspectOpen: z.boolean().optional(),
    inspectWidth: coordinate.optional(),
    editingPrompt: z
      .object({
        id: z.string().min(1),
        frozen: z.boolean(),
        revision: z.number().int().nonnegative().optional(),
      })
      .strict()
      .nullable(),
    editingSentMessage: z
      .object({
        id: z.string().min(1),
        text: z.string(),
        error: z.string().nullable(),
      })
      .strict()
      .nullable(),
    inspectTab: z.enum(["trajectory", "state"]),
    trajectoryTargetKey: z.string().nullable(),
    sidePanelView: z.discriminatedUnion("type", [
      z.object({ type: z.literal("inspect") }).strict(),
      z
        .object({
          type: z.literal("subagent"),
          agentKey: z.string(),
          focusItemKey: z.string().nullable(),
        })
        .strict(),
      z
        .object({ type: z.literal("subagent-root"), rootTurnId: z.string() })
        .strict(),
    ]),
  })
  .strict();

export type ChatViewState = z.infer<typeof chatViewStateSchema>;
export interface ChatTransferOwner {
  tabId: string;
  chatId: string;
  projectId: string;
}

export function parseChatViewState(
  value: unknown,
  expected: Omit<ChatTransferOwner, "tabId">,
): ChatViewState {
  const state = chatViewStateSchema.parse(value);
  if (
    state.chatId !== expected.chatId ||
    state.projectId !== expected.projectId
  )
    throw new Error("Transferred chat does not match its reservation.");
  if (
    state.composerSelection.start > state.composerSelection.end ||
    state.composerSelection.end > state.draft.text.length
  )
    throw new Error("Invalid transferred composer selection.");
  if (
    state.draft.attachments?.some(
      (attachment) =>
        attachment.chatId !== expected.chatId ||
        attachment.status !== "ready" ||
        attachment.id.startsWith("local-"),
    )
  )
    throw new Error(
      "Transferred chat attachment is not ready or belongs to another chat.",
    );
  return state;
}

export interface ChatTransferLifecycle {
  suspendTransfer(): () => void;
  captureTransfer(): Promise<ChatViewState>;
  retireTransfer(): Promise<void>;
}
export interface ChatTransferStaging {
  onRestored(): void;
  onError(error: unknown): void;
}

export interface IncomingChatView {
  tabId: string;
  chat: ChatSummary;
  state: ChatViewState;
  staging?: ChatTransferStaging;
}
