import {
  agentActivitySchema,
  chatMessageContentSchema,
  type AgentScope,
  type ChatMessageCreate,
  type ChatMessageContent,
  type NativeHistoryPreparedBatch,
} from "@cantrip/protocol";
import { renderNativeDisplayItem } from "./native-history-display-items.js";
import { normalizeCodexThreadItem } from "./codex/app-server.js";
import type { NativeHistoryStateItem } from "./native-history-state.js";

type Identity = NativeHistoryPreparedBatch["items"][number]["identity"];
export interface NativeHistoryRenderedItem {
  identity: Identity;
  source: NativeHistoryStateItem;
  message: Omit<ChatMessageCreate, "idempotencyKey">;
  /** Render limitations, not a reason to drop or acknowledge the source body.
   * The durable projector retains the original item independently of this view. */
  unresolved: Array<{ kind: string; index: number | null }>;
}
export interface NativeHistoryRenderContext {
  threadId: string;
  turnId: string;
  cwd: string;
  mode: NonNullable<ChatMessageCreate["mode"]>;
  /** Already resolved from verified parent/child ownership by the caller. */
  agentScope?: AgentScope;
  /** Materialized, authorized attachments/references only. Rendering performs no
   * filesystem or network reads and does not resolve paths supplied by an item. */
  inputParts?: ReadonlyMap<number, ChatMessageContent>;
}

/** Presentation of one reduced item. Identity/lifecycle come from the item,
 * never its input origin, the containing turn's status, text equality or clock.
 * This does not reserve message IDs, encrypt, dispatch input or commit a source. */
export function renderNativeHistoryItem(
  item: NativeHistoryStateItem,
  context: NativeHistoryRenderContext,
): NativeHistoryRenderedItem[] {
  if (
    context.agentScope?.agentThreadId !== undefined &&
    context.agentScope.agentThreadId !== context.threadId
  )
    throw new Error("Native history render scope belongs to another thread.");
  const body = item.body;
  const correlation = {
    sourceMethod: "native-history",
    diagnosticId: null,
    threadId: context.threadId,
    turnId: context.turnId,
    itemId: item.id,
  };
  const identity = (component: string): Identity => ({
    threadId: context.threadId,
    turnId: context.turnId,
    itemId: item.id,
    identityKind: item.identityKind,
    component,
  });
  const notice = (
    message: string,
    details: string,
    suffix = "notice",
  ): ChatMessageContent[number] => ({
    type: "activity",
    activity: agentActivitySchema.parse({
      type: "notice",
      id: `${item.id}:${suffix}`,
      status: "completed", // The notice is available; this is not an input receipt.
      level: "warning",
      message,
      details,
      willRetry: null,
      correlation,
      ...(context.agentScope ? { agentScope: context.agentScope } : {}),
    }),
  });
  const rendered = (
    component: string,
    role: ChatMessageCreate["role"],
    content: ChatMessageContent,
    unresolved: NativeHistoryRenderedItem["unresolved"] = [],
  ): NativeHistoryRenderedItem => ({
    identity: identity(component),
    source: structuredClone(item),
    message: {
      role,
      mode: context.mode,
      content: chatMessageContentSchema.parse(
        item.conflicts.length
          ? [
              ...content,
              notice(
                "Conflicting native item versions were retained.",
                "The available ordering evidence does not establish which version supersedes the other.",
                "conflict",
              ),
            ]
          : content,
      ),
    },
    unresolved: item.conflicts.length
      ? [...unresolved, { kind: "conflicting-item-versions", index: null }]
      : unresolved,
  });
  if (body.type === "userMessage") {
    const content: ChatMessageContent = [];
    const unresolved: NativeHistoryRenderedItem["unresolved"] = [];
    if (Array.isArray(body.content)) {
      body.content.forEach((part, index) => {
        if (
          part &&
          typeof part === "object" &&
          !Array.isArray(part) &&
          part.type === "text" &&
          typeof part.text === "string"
        ) {
          if (part.text.length) content.push({ type: "text", text: part.text });
          return;
        }
        const resolved = context.inputParts?.get(index);
        if (resolved?.length) {
          content.push(...resolved);
          return;
        }
        const kind =
          part &&
          typeof part === "object" &&
          !Array.isArray(part) &&
          typeof part.type === "string"
            ? part.type
            : "unknown";
        unresolved.push({ kind, index });
        content.push(
          notice(
            "Native input content is unavailable in this view.",
            `Input part ${index + 1}: ${kind}. Its source record is retained.`,
            `input:${index}`,
          ),
        );
      });
    } else unresolved.push({ kind: "invalid-user-content", index: null });
    if (!content.length)
      content.push(
        notice(
          "This native input has no displayable content.",
          "The input identity and source record are retained.",
        ),
      );
    return [rendered("user", "user", content, unresolved)];
  }
  if (body.type === "agentMessage") {
    const phase =
      body.phase === "commentary" || body.phase === "final_answer"
        ? body.phase
        : null;
    const content: ChatMessageContent =
      typeof body.text === "string" && body.text.length
        ? [
            {
              type: "text",
              text: body.text,
              phase,
              streaming: item.lifecycle === "started",
              correlation,
              ...(context.agentScope ? { agentScope: context.agentScope } : {}),
            },
          ]
        : [
            notice(
              "This native assistant item has no displayable text.",
              "The item identity and source record are retained.",
            ),
          ];
    return [
      rendered(
        "assistant",
        "assistant",
        content,
        typeof body.text === "string"
          ? []
          : [{ kind: "invalid-agent-text", index: null }],
      ),
    ];
  }
  const display = renderNativeDisplayItem(item, context);
  if (display)
    return [
      rendered("activity", "assistant", display.content, display.unresolved),
    ];
  const timestamps = {
    ...(item.startedAtMs === null ? {} : { startedAtMs: item.startedAtMs }),
    completedAtMs: item.completedAtMs,
  };
  // Keep one stable activity identity even when authoritative completion replaces
  // or shortens streamed summaries. Pack overflow into the last display paragraph
  // without dropping text; exact original part boundaries remain in source.
  if (body.type === "reasoning" && item.lifecycle !== "unknown") {
    const summary =
      body.summaryParts &&
      typeof body.summaryParts === "object" &&
      !Array.isArray(body.summaryParts)
        ? Object.entries(body.summaryParts)
            .filter(([key]) => /^(0|[1-9][0-9]*)$/u.test(key))
            .sort(
              ([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
            )
            .map(([, value]) => value)
        : Array.isArray(body.summary)
          ? body.summary
          : [];
    if (summary.every((part) => typeof part === "string")) {
      const parts = summary.filter((part) => part.length > 0);
      return [
        rendered("activity", "assistant", [
          {
            type: "activity",
            activity: agentActivitySchema.parse({
              type: "reasoning",
              id: item.id,
              summary:
                parts.length > 100
                  ? [...parts.slice(0, 99), parts.slice(99).join("\n\n")]
                  : parts,
              status: item.lifecycle === "completed" ? "completed" : "running",
              ...timestamps,
              correlation,
              ...(context.agentScope ? { agentScope: context.agentScope } : {}),
            }),
          },
        ]),
      ];
    }
  }
  let limitation = "unsupported-item";
  if (item.lifecycle !== "unknown") {
    try {
      const activity = normalizeCodexThreadItem(
        body as unknown as Parameters<typeof normalizeCodexThreadItem>[0],
        context.cwd,
        item.lifecycle,
        correlation,
        { ...timestamps, captureRaw: true },
      );
      if (activity) {
        // Common live normalizers intentionally bound previews. Keep exact plain
        // text/output where the transcript schema permits it. Full source bodies
        // (including bounded raw tool previews) remain the projector's evidence.
        if (
          activity.type === "command" &&
          typeof body.aggregatedOutput === "string"
        )
          activity.output = body.aggregatedOutput;
        if (activity.type === "plan" && typeof body.text === "string")
          activity.text = body.text;
        return [
          rendered("activity", "assistant", [
            {
              type: "activity",
              activity: {
                ...activity,
                ...(context.agentScope
                  ? { agentScope: context.agentScope }
                  : {}),
              },
            },
          ]),
        ];
      }
    } catch {
      limitation = "invalid-item-presentation";
    }
  } else limitation = "unknown-item-lifecycle";
  return [
    rendered(
      "activity",
      "assistant",
      [
        notice(
          "A native history item could not be fully rendered.",
          `Item type: ${typeof body.type === "string" ? body.type : "unknown"}; ${limitation}. Its source record is retained.`,
        ),
      ],
      [{ kind: limitation, index: null }],
    ),
  ];
}
