import {
  agentActivitySchema,
  type ChatMessageContent,
} from "@cantrip/protocol";
import type {
  NativeHistoryRenderContext,
  NativeHistoryRenderedItem,
} from "./native-history-render.js";
import type { NativeHistoryStateItem } from "./native-history-state.js";
import { describeAgentCommunication } from "./codex/agent-communication.js";

/** Additional pinned-native display items. The source is retained separately;
 * output text is activity detail, never an assistant answer or a user prompt. */
export function renderNativeDisplayItem(
  item: NativeHistoryStateItem,
  context: NativeHistoryRenderContext,
): {
  content: ChatMessageContent;
  unresolved: NativeHistoryRenderedItem["unresolved"];
} | null {
  const body = item.body;
  const kind = body.type;
  if (
    item.lifecycle === "unknown" ||
    (kind !== "hookPrompt" &&
      kind !== "interAgentCommunication" &&
      kind !== "functionCallOutput" &&
      kind !== "sleep" &&
      kind !== "imageGeneration")
  )
    return null;
  const content: ChatMessageContent = [];
  const unresolved: NativeHistoryRenderedItem["unresolved"] = [];
  const correlation = {
    sourceMethod: "native-history",
    diagnosticId: null,
    threadId: context.threadId,
    turnId: context.turnId,
    itemId: item.id,
  };
  const status = item.lifecycle === "started" ? "running" : "completed";
  const activity = (
    title: string,
    details: string | null,
    suffix = "",
    failed = false,
  ) => {
    content.push({
      type: "activity",
      activity: agentActivitySchema.parse({
        type: "nativeItem",
        kind,
        id: `${item.id}${suffix}`,
        title,
        details,
        status: failed ? "failed" : status,
        durationMs:
          item.startedAtMs !== null &&
          item.completedAtMs !== null &&
          item.completedAtMs >= item.startedAtMs
            ? item.completedAtMs - item.startedAtMs
            : null,
        ...(item.startedAtMs === null ? {} : { startedAtMs: item.startedAtMs }),
        completedAtMs: item.completedAtMs,
        correlation,
        ...(context.agentScope ? { agentScope: context.agentScope } : {}),
      }),
    });
  };
  const missing = (partKind: string, index: number) => {
    unresolved.push({ kind: partKind, index });
    content.push({
      type: "activity",
      activity: agentActivitySchema.parse({
        type: "notice",
        id: `${item.id}:unavailable:${index}`,
        status: "completed",
        level: "warning",
        message: "Native output content is unavailable in this view.",
        details: `Output part ${index + 1}: ${partKind}. Its source record is retained.`,
        willRetry: null,
        correlation,
        ...(context.agentScope ? { agentScope: context.agentScope } : {}),
      }),
    });
  };
  if (kind === "interAgentCommunication") {
    const description = describeAgentCommunication(body);
    if (!description) return null;
    activity(description.title, description.details);
    if (description.unavailable) missing(description.unavailable, 0);
  } else if (kind === "hookPrompt") {
    if (
      !Array.isArray(body.fragments) ||
      !body.fragments.every(
        (part): part is { text: string; hookRunId: string } =>
          part !== null &&
          typeof part === "object" &&
          !Array.isArray(part) &&
          typeof part.text === "string" &&
          typeof part.hookRunId === "string",
      )
    )
      return null;
    for (const [index, fragment] of body.fragments.entries())
      activity(
        `Hook prompt · ${fragment.hookRunId}`,
        fragment.text,
        index ? `:fragment:${index}` : "",
      );
    if (!content.length) activity("Hook prompt", null);
  } else if (kind === "functionCallOutput") {
    if (
      typeof body.name !== "string" ||
      !body.name.length ||
      (body.namespace !== null &&
        body.namespace !== undefined &&
        typeof body.namespace !== "string")
    )
      return null;
    const title = `Tool output · ${body.namespace ? `${body.namespace}/` : ""}${body.name}`;
    if (typeof body.output === "string") activity(title, body.output);
    else if (Array.isArray(body.output)) {
      activity(title, null);
      for (const [index, part] of body.output.entries()) {
        if (part && typeof part === "object" && !Array.isArray(part)) {
          if (part.type === "input_text" && typeof part.text === "string") {
            activity(title, part.text, `:output:${index}`);
            continue;
          }
          if (part.type === "input_image" || part.type === "input_audio") {
            const resolved = context.inputParts?.get(index);
            if (resolved?.length) {
              content.push(...resolved);
              continue;
            }
          }
          missing(typeof part.type === "string" ? part.type : "unknown", index);
        } else missing("invalid-tool-output", index);
      }
    } else return null;
  } else if (kind === "sleep") {
    if (
      typeof body.durationMs !== "number" ||
      !Number.isSafeInteger(body.durationMs) ||
      body.durationMs < 0
    )
      return null;
    // Requested duration is not proof of elapsed time; sleep can be interrupted.
    activity(
      status === "running" ? "Waiting" : "Wait ended",
      `Requested wait: ${body.durationMs} ms`,
    );
  } else {
    if (typeof body.status !== "string" || typeof body.result !== "string")
      return null;
    const failed = body.status === "failed" || body.failure != null;
    const details = [
      `Status: ${body.status}`,
      typeof body.revisedPrompt === "string" ? body.revisedPrompt : null,
      typeof body.savedPath === "string"
        ? `Saved path: ${body.savedPath}`
        : null,
      typeof body.transparentBackground === "boolean"
        ? `Transparent background: ${body.transparentBackground}`
        : null,
      body.failure != null ? `Failure: ${JSON.stringify(body.failure)}` : null,
    ]
      .filter((value) => value !== null)
      .join("\n\n");
    activity("Image generation", details, "", failed);
    if (body.result.length) {
      const resolved = context.inputParts?.get(0);
      if (resolved?.length) content.push(...resolved);
      else missing("generated-image", 0);
    } else if (item.lifecycle === "completed" && !failed)
      missing("generated-image", 0);
  }
  return { content, unresolved };
}
