import { createHash } from "node:crypto";

import {
  DEFAULT_PERMISSION_PROFILE_ID,
  type AgentActivity,
  type ChatMessage,
  type ChatWireSummary,
} from "@cantrip/protocol";

import type { ChatExecutionContext } from "../db/repository.js";
import { errorMessage } from "../http/request-helpers.js";

export function chatIsExecuting(status: ChatWireSummary["status"]): boolean {
  return status === "running" || status === "waiting-for-approval";
}

export function effectivePermissionProfile(context: ChatExecutionContext) {
  const defaultId =
    context.defaultPermissionProfileId ?? DEFAULT_PERMISSION_PROFILE_ID;
  const selectedId = context.permissionProfileId ?? defaultId;
  const forcedByWorktreePolicy =
    context.isPrimary && context.worktreePolicy === "required-for-writes";
  return {
    selectedId,
    effectiveId: forcedByWorktreePolicy ? ":read-only" : selectedId,
    defaultId,
    usesDefault: context.permissionProfileId === null,
    forcedByWorktreePolicy,
  };
}

export function scopedCodeProfileId(
  ownerId: string,
  profileId: string,
): string {
  return createHash("sha256").update(`${ownerId}\0${profileId}`).digest("hex");
}

export function canFailOverRoute(error: unknown): boolean {
  return /(quota|usage limit|rate.?limit|\b429\b|unauthori[sz]ed|\b401\b|forbidden|\b403\b|authentication|credentials|model.+(?:not found|unavailable)|\b404\b|timed? out|timeout|ECONN|connection|network|socket|\b5\d\d\b|service unavailable|overloaded)/i.test(
    errorMessage(error),
  );
}

function activityContinuationSummary(activity: AgentActivity): string {
  switch (activity.type) {
    case "instructionContext":
      return `[effective instructions: ${activity.provenance}]`;
    case "command":
      return `[command: ${activity.command}]`;
    case "fileChange":
      return `[files: ${activity.changes.map((change) => change.path).join(", ")}]`;
    case "worktree":
      return `[worktree: ${activity.summary}]`;
    case "plan":
      return `[plan: ${activity.text || activity.explanation || `${activity.steps.length} steps`}]`;
    case "reasoning":
      return `[reasoning summary: ${activity.summary.join(" ")}]`;
    case "mcpToolCall":
      return `[MCP tool: ${activity.server}/${activity.tool} ${activity.status}]`;
    case "dynamicToolCall":
      return `[tool: ${activity.namespace ? `${activity.namespace}/` : ""}${activity.tool} ${activity.status}]`;
    case "collabToolCall":
      return `[collaboration: ${activity.tool} ${activity.status}]`;
    case "subAgent":
      return `[subagent: ${activity.agentPath} ${activity.kind}]`;
    case "agentCommunication":
      return `[subagent communication: ${activity.kind}]`;
    case "webSearch":
      return `[web search: ${activity.query}]`;
    case "imageView":
      return `[viewed image: ${activity.path}]`;
    case "reviewMode":
      return `[review mode ${activity.state}]`;
    case "contextCompaction":
      return "[context compacted]";
    case "notice":
      return `[${activity.level}: ${activity.message}]`;
    case "usage":
      return `[usage: ${activity.last.totalTokens} tokens]`;
    case "rateLimit":
      return `[rate limit: ${activity.primary?.usedPercent ?? "unknown"}% used]`;
    case "turnSummary":
      return `[turn ${activity.status}${activity.durationMs === null ? "" : ` in ${activity.durationMs}ms`}]`;
  }
}

export function continuationPrompt(
  messages: ChatMessage[],
  prompt: string,
): string {
  if (messages.length === 0) return prompt;
  const transcript = messages
    .slice(-100)
    .map((message) => {
      const content = message.content
        .flatMap((item) => {
          if (item.type === "text") return [item.text];
          if (item.type === "attachment") {
            return ["[attachment]"];
          }
          return [activityContinuationSummary(item.activity)];
        })
        .join("\n");
      return `${message.role.toUpperCase()}: ${content}`;
    })
    .join("\n\n");
  return `Continue this existing Cantrip conversation. The server-owned history follows:\n\n${transcript}\n\nUSER: ${prompt}`;
}
