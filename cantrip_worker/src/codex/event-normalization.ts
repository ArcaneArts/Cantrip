import type {
  AgentActivity,
  AgentThreadSync,
  AgentThreadSyncItem,
  CodexEventCorrelation,
  NativeInitialTurnSettings,
  NormalizedAgentMessage,
} from "@cantrip/protocol";
import {
  asCommentary,
  boundedText,
  codexErrorReasonCode,
  displayPath,
  eventCorrelation,
  settleRunningActivityAtTurnBoundary,
  stableActivityId,
} from "./event-values.js";
import {
  createAgentActivityRawEnvelope,
  redactAgentActivityText,
} from "./raw-capture.js";
import type {
  AccountRateLimitsUpdatedParams,
  AgentMessageItem,
  CodexThreadItem,
  CodexThreadReadResponse,
  CodexThreadTurn,
  FileUpdateChange,
  McpToolCallItem,
  ThreadTokenUsageUpdatedParams,
  WebSearchItem,
} from "./event-types.js";
import {
  agentActivitySchema,
  agentFilePreviewLimitCharacters,
  agentThreadSyncSchema,
  normalizedAgentMessageSchema,
} from "@cantrip/protocol";
import type {
  ActiveTurn,
  CommandOutputBuffer,
  FileActivityChange,
} from "./runtime-types.js";
import { describeAgentCommunication } from "./agent-communication.js";
import {
  boundedCommandOutput,
  transcriptCommandOutput,
} from "./command-output.js";

function activityStatus(
  status: "inProgress" | "completed" | "failed" | "declined",
): AgentActivity["status"] {
  return status === "inProgress" ? "running" : status;
}

function boundedJson(value: unknown) {
  if (value === null || value === undefined) return null;
  try {
    return boundedText(
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    );
  } catch {
    return null;
  }
}

function objectStringField(value: unknown, field: string) {
  if (typeof value !== "object" || value === null || !(field in value)) {
    return null;
  }
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : null;
}

interface NormalizedMcpFailure {
  code: string | null;
  message: string;
  retryable: boolean | null;
}

interface McpFailureCandidate {
  code?: unknown;
  message: string;
  retryable?: unknown;
}

function primitiveMcpErrorCode(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string") return null;
  const code = redactAgentActivityText(value).trim();
  return code && code.length <= 200 ? code : null;
}

function explicitMcpRetryability(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function genericMcpFailureMessage(message: string): boolean {
  return /^(?:(?:mcp|tool)\s+)?(?:tool\s+)?call failed[.!]?$/iu.test(
    message.trim(),
  );
}

function parsedMcpJson(text: string): unknown {
  const trimmed = text.trim();
  if (!(
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  )) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function mcpFailureCandidate(
  value: unknown,
  depth = 0,
): McpFailureCandidate | null {
  if (depth > 8 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    const parsed = parsedMcpJson(value);
    return parsed === null
      ? value.trim()
        ? { message: value }
        : null
      : mcpFailureCandidate(parsed, depth + 1);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const candidate = mcpFailureCandidate(entry, depth + 1);
      if (candidate) return candidate;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const code = record.code ?? record.errorCode;
  const retryable =
    record.retryable ?? record.willRetry ?? record.canRetry ?? undefined;
  const directMessage =
    typeof record.message === "string"
      ? record.message
      : typeof record.error === "string"
        ? record.error
        : null;
  if (directMessage?.trim()) {
    return { code, message: directMessage, retryable };
  }
  for (const field of [
    "error",
    "result",
    "structuredContent",
    "data",
    "cause",
  ]) {
    const nested = mcpFailureCandidate(record[field], depth + 1);
    if (nested) {
      return {
        code: nested.code ?? code,
        message: nested.message,
        retryable: nested.retryable ?? retryable,
      };
    }
  }
  if (Array.isArray(record.content)) {
    for (const content of record.content) {
      if (
        typeof content === "object" &&
        content !== null &&
        "text" in content &&
        typeof content.text === "string"
      ) {
        const nested = mcpFailureCandidate(content.text, depth + 1);
        if (nested) {
          return {
            code: nested.code ?? code,
            message: nested.message,
            retryable: nested.retryable ?? retryable,
          };
        }
      }
    }
  }
  return null;
}

function normalizedMcpFailure(
  item: Pick<McpToolCallItem, "error" | "result" | "status">,
): NormalizedMcpFailure | null {
  if (
    item.status !== "failed" &&
    !item.error &&
    item.result?.isError !== true &&
    item.result?.status !== "failed"
  ) {
    return null;
  }
  const resultCandidate = mcpFailureCandidate(item.result);
  const explicitCandidate = item.error
    ? {
        code: item.error.code,
        message: item.error.message,
        retryable: item.error.retryable,
      }
    : null;
  const candidate =
    resultCandidate &&
    (!explicitCandidate || genericMcpFailureMessage(explicitCandidate.message))
      ? resultCandidate
      : (explicitCandidate ?? resultCandidate);
  if (!candidate) return null;
  const message =
    boundedText(redactAgentActivityText(candidate.message).trim(), 4_000) ?? "";
  if (!message) return null;
  const embeddedCode =
    /\bMCP error\s+(-?\d+)\b/iu.exec(message)?.[1] ??
    /\bHTTP\s+(\d{3})\b/iu.exec(message)?.[1] ??
    null;
  return {
    code:
      primitiveMcpErrorCode(candidate.code) ??
      primitiveMcpErrorCode(explicitCandidate?.code) ??
      primitiveMcpErrorCode(resultCandidate?.code) ??
      embeddedCode,
    message,
    retryable:
      explicitMcpRetryability(candidate.retryable) ??
      explicitMcpRetryability(explicitCandidate?.retryable) ??
      explicitMcpRetryability(resultCandidate?.retryable),
  };
}

function mcpResultText(result: McpToolCallItem["result"]) {
  if (!result) return null;
  const text = (result.content ?? [])
    .flatMap((content) => {
      if (
        typeof content === "object" &&
        content !== null &&
        "text" in content &&
        typeof content.text === "string"
      ) {
        return [content.text];
      }
      return [];
    })
    .join("\n\n")
    .trim();
  if (text) return boundedText(redactAgentActivityText(text));
  if (
    result.structuredContent !== null &&
    result.structuredContent !== undefined
  ) {
    const serialized = boundedJson(result.structuredContent);
    return serialized ? redactAgentActivityText(serialized) : null;
  }
  const serialized =
    (result.content?.length ?? 0) > 0 ? boundedJson(result.content) : null;
  return serialized ? redactAgentActivityText(serialized) : null;
}

function boundedFilePreview(value: string): string {
  return value.length <= agentFilePreviewLimitCharacters
    ? value
    : value.slice(-agentFilePreviewLimitCharacters);
}

function nativeFileChangePreview(change: FileUpdateChange): {
  latestLine?: string;
  diffPreview?: string;
} {
  if (!change.diff) return {};
  if (change.kind.type === "update") {
    const latestLine = latestChangedLine(change.diff);
    const diffPreview = changedLinesPreview(change.diff);
    return {
      ...(latestLine === null ? {} : { latestLine }),
      ...(diffPreview === null ? {} : { diffPreview }),
    };
  }
  // Native additions/deletions contain the file content, not a unified diff.
  const lines = boundedFilePreview(change.diff)
    .replace(/\r?\n$/u, "")
    .split(/\r?\n/u);
  const marker = change.kind.type === "add" ? "+" : "-";
  return {
    latestLine: lines[lines.length - 1]!,
    diffPreview: boundedFilePreview(
      lines.map((line) => `${marker}${line}`).join("\n"),
    ),
  };
}

export function latestChangedLine(
  diff: string | null | undefined,
): string | null {
  if (!diff) return null;
  let latestAdded: string | null = null;
  let latestRemoved: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++ ")) {
      latestAdded = line.slice(1);
    } else if (line.startsWith("-") && !line.startsWith("--- ")) {
      latestRemoved = line.slice(1);
    }
  }
  const latest = latestAdded ?? latestRemoved;
  return latest === null ? null : boundedFilePreview(latest);
}

export function changedLinesPreview(
  diff: string | null | undefined,
): string | null {
  if (!diff) return null;
  const preview = diff
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("+") && !line.startsWith("+++ ")) ||
        (line.startsWith("-") && !line.startsWith("--- ")),
    )
    .join("\n");
  return preview ? boundedFilePreview(preview) : null;
}

export function changedFiles(
  diff: string,
  lastActivityAtMs?: number,
): ActiveTurn["diffChanges"] {
  return diff
    .split(/^diff --git /m)
    .slice(1)
    .flatMap((section) => {
      const header = section.split("\n", 1)[0] ?? "";
      const match = /^a\/(.+) b\/(.+)$/.exec(header);
      if (!match?.[2]) {
        return [];
      }
      const latestLine = latestChangedLine(section);
      const diffPreview = changedLinesPreview(section);
      return [
        {
          path: match[2],
          kind: section.includes("\nnew file mode ")
            ? ("add" as const)
            : section.includes("\ndeleted file mode ")
              ? ("delete" as const)
              : ("update" as const),
          ...(latestLine === null ? {} : { latestLine }),
          ...(diffPreview === null ? {} : { diffPreview }),
          ...(lastActivityAtMs === undefined ? {} : { lastActivityAtMs }),
        },
      ];
    });
}

function webSearchAction(item: WebSearchItem): string | null {
  if (!item.action) return null;
  if (item.action.type === "open_page") {
    return item.action.url
      ? `Opened ${safeDisplayUrl(item.action.url)}`
      : "Opened a page";
  }
  if (item.action.type === "find_in_page") {
    const location = item.action.url
      ? ` in ${safeDisplayUrl(item.action.url)}`
      : "";
    return item.action.pattern
      ? `Found “${item.action.pattern}”${location}`
      : `Searched within a page${location}`;
  }
  if (item.action.type === "search") {
    const queries =
      item.action.queries ?? (item.action.query ? [item.action.query] : []);
    return queries.length > 0 ? `Searched ${queries.join(", ")}` : "Searched";
  }
  return item.action.type === "other" ? "Web search" : item.action.type;
}

function safeDisplayUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.split(/[?#]/u, 1)[0] ?? "page";
  }
}

function createThreadItemRawCapture(
  item: CodexThreadItem,
  commandOutput?: CommandOutputBuffer,
) {
  const metadata = { itemId: item.id, itemType: item.type };
  switch (item.type) {
    case "commandExecution":
      return createAgentActivityRawEnvelope({
        request: { command: item.command, cwd: item.cwd },
        response: {
          durationMs: item.durationMs ?? null,
          exitCode: item.exitCode,
          output: commandOutput?.output ?? item.aggregatedOutput,
          outputTruncated: commandOutput?.truncated ?? false,
          status: item.status,
        },
        metadata,
      });
    case "fileChange":
      return createAgentActivityRawEnvelope({
        request: { changes: item.changes },
        response: {
          changes: item.changes.map((change) => ({
            kind: change.kind.type,
            path: change.path,
          })),
          status: item.status,
        },
        metadata,
      });
    case "plan":
      return createAgentActivityRawEnvelope({
        response: { text: item.text },
        metadata,
      });
    case "reasoning":
      return createAgentActivityRawEnvelope({
        response: { content: item.content, summary: item.summary },
        metadata,
      });
    case "mcpToolCall":
      return createAgentActivityRawEnvelope({
        request: item.arguments,
        response: {
          error: item.error,
          result: item.result,
          status: item.status,
        },
        metadata: { ...metadata, server: item.server, tool: item.tool },
      });
    case "dynamicToolCall":
      return createAgentActivityRawEnvelope({
        response: {
          durationMs: item.durationMs,
          status: item.status,
          success: item.success,
        },
        metadata: {
          ...metadata,
          namespace: item.namespace,
          tool: item.tool,
        },
      });
    case "collabAgentToolCall":
      return createAgentActivityRawEnvelope({
        request: {
          model: item.model,
          prompt: item.prompt,
          receiverThreadIds: item.receiverThreadIds,
          senderThreadId: item.senderThreadId,
        },
        response: { agentStates: item.agentsStates, status: item.status },
        metadata: { ...metadata, tool: item.tool },
      });
    case "subAgentActivity":
      return createAgentActivityRawEnvelope({
        response: {
          agentPath: item.agentPath,
          agentThreadId: item.agentThreadId,
          kind: item.kind,
        },
        metadata,
      });
    case "webSearch":
      return createAgentActivityRawEnvelope({
        request: { query: item.query },
        response: { action: item.action },
        metadata,
      });
    case "imageView":
      return createAgentActivityRawEnvelope({
        request: { path: item.path },
        metadata,
      });
    case "enteredReviewMode":
    case "exitedReviewMode":
      return createAgentActivityRawEnvelope({
        request: { review: item.review },
        metadata,
      });
    case "contextCompaction":
      return createAgentActivityRawEnvelope({ metadata });
    case "agentMessage":
      return createAgentActivityRawEnvelope({
        response: { phase: item.phase, text: item.text },
        metadata,
      });
  }
}

export function normalizeCodexThreadItem(
  item: CodexThreadItem,
  cwd: string,
  lifecycle: "started" | "completed",
  correlation: CodexEventCorrelation,
  telemetry: {
    commandOutput?: CommandOutputBuffer;
    captureRaw?: boolean;
    completedAtMs?: number | null;
    fileChanges?: FileActivityChange[];
    startedAtMs?: number;
    status?: AgentActivity["status"];
    updatedAtMs?: number;
  } = {},
): AgentActivity | null {
  const timestamps = {
    ...(telemetry.startedAtMs === undefined
      ? {}
      : { startedAtMs: telemetry.startedAtMs }),
    ...(telemetry.updatedAtMs === undefined
      ? {}
      : { updatedAtMs: telemetry.updatedAtMs }),
    ...(telemetry.completedAtMs === undefined
      ? {}
      : { completedAtMs: telemetry.completedAtMs }),
  };
  const raw = telemetry.captureRaw
    ? {
        raw: createThreadItemRawCapture(item, telemetry.commandOutput),
      }
    : {};
  if (item.type === "interAgentCommunication") {
    const description = describeAgentCommunication(item);
    if (!description) return null;
    return agentActivitySchema.parse({
      type: "nativeItem",
      kind: item.type,
      id: item.id,
      title: description.title,
      details:
        description.details ??
        (description.unavailable === "encrypted-agent-communication"
          ? "Encrypted agent message; text unavailable."
          : "Agent message text unavailable."),
      status: lifecycle === "started" ? "running" : "completed",
      durationMs:
        telemetry.startedAtMs !== undefined &&
        telemetry.completedAtMs != null &&
        telemetry.completedAtMs >= telemetry.startedAtMs
          ? telemetry.completedAtMs - telemetry.startedAtMs
          : null,
      ...timestamps,
      correlation,
    });
  }
  if (item.type === "commandExecution") {
    const output =
      telemetry.commandOutput ?? boundedCommandOutput(item.aggregatedOutput);
    return agentActivitySchema.parse({
      type: "command",
      id: item.id,
      command: item.command,
      cwd: displayPath(cwd, item.cwd) || ".",
      status: activityStatus(item.status),
      exitCode: item.exitCode,
      output: transcriptCommandOutput(item.aggregatedOutput),
      outputTail: output.output,
      outputTruncated: output.truncated,
      durationMs: item.durationMs ?? null,
      ...raw,
      ...timestamps,
      ...(telemetry.status === undefined ? {} : { status: telemetry.status }),
      correlation,
    });
  }
  if (item.type === "fileChange") {
    const changes =
      telemetry.fileChanges ??
      item.changes.map((change) => {
        return {
          path: displayPath(cwd, change.path),
          kind: change.kind.type,
          ...nativeFileChangePreview(change),
          ...(telemetry.updatedAtMs === undefined
            ? {}
            : { lastActivityAtMs: telemetry.updatedAtMs }),
        };
      });
    return agentActivitySchema.parse({
      type: "fileChange",
      id: item.id,
      status: activityStatus(item.status),
      changes,
      ...raw,
      ...timestamps,
      correlation,
    });
  }
  if (item.type === "plan") {
    return agentActivitySchema.parse({
      type: "plan",
      id: item.id,
      status: lifecycle === "started" ? "running" : "completed",
      text: boundedText(item.text) ?? "",
      explanation: null,
      steps: [],
      ...raw,
      ...timestamps,
      correlation,
    });
  }
  if (item.type === "reasoning") {
    return agentActivitySchema.parse({
      type: "reasoning",
      id: item.id,
      status: lifecycle === "started" ? "running" : "completed",
      summary: item.summary
        .map((part) => boundedText(part)?.trim() ?? "")
        .filter(Boolean)
        .slice(0, 100),
      ...raw,
      ...timestamps,
      correlation,
    });
  }
  if (item.type === "mcpToolCall") {
    const isCodeGraph = item.server.toLowerCase() === "codegraph";
    const failure = normalizedMcpFailure(item);
    return agentActivitySchema.parse({
      type: "mcpToolCall",
      id: item.id,
      status: failure ? "failed" : activityStatus(item.status),
      server: item.server,
      tool: item.tool,
      query: isCodeGraph
        ? boundedText(objectStringField(item.arguments, "query"), 4_000)
        : null,
      resultText: isCodeGraph && !failure ? mcpResultText(item.result) : null,
      error: failure?.message ?? null,
      errorCode: failure?.code ?? null,
      retryable: failure?.retryable ?? null,
      durationMs: item.durationMs,
      ...raw,
      ...timestamps,
      correlation,
    });
  }
  if (item.type === "dynamicToolCall") {
    return agentActivitySchema.parse({
      type: "dynamicToolCall",
      id: item.id,
      status: activityStatus(item.status),
      namespace: item.namespace?.trim() || null,
      tool: item.tool,
      success: item.success,
      durationMs: item.durationMs,
      ...raw,
      ...timestamps,
      correlation,
    });
  }
  if (item.type === "collabAgentToolCall") {
    return agentActivitySchema.parse({
      type: "collabToolCall",
      id: item.id,
      status: activityStatus(item.status),
      tool: item.tool,
      senderThreadId: item.senderThreadId,
      receiverThreadIds: item.receiverThreadIds.slice(0, 100),
      prompt: boundedText(item.prompt, 100_000),
      model: item.model,
      agentStates: Object.entries(item.agentsStates)
        .flatMap(([threadId, state]) =>
          state
            ? [
                {
                  threadId,
                  status: state.status,
                  message: boundedText(state.message, 4_000),
                },
              ]
            : [],
        )
        .slice(0, 100),
      ...raw,
      ...timestamps,
      correlation,
    });
  }
  if (item.type === "subAgentActivity") {
    return agentActivitySchema.parse({
      type: "subAgent",
      id: item.id,
      status:
        item.kind === "started"
          ? "running"
          : item.kind === "interrupted"
            ? "failed"
            : "completed",
      kind: item.kind,
      agentThreadId: item.agentThreadId,
      agentPath: item.agentPath || item.agentThreadId,
      ...raw,
      ...timestamps,
      correlation,
    });
  }
  if (item.type === "webSearch") {
    return agentActivitySchema.parse({
      type: "webSearch",
      id: item.id,
      status: lifecycle === "started" ? "running" : "completed",
      query: boundedText(item.query, 4_000) ?? "",
      action: boundedText(webSearchAction(item), 4_000),
      ...raw,
      ...timestamps,
      correlation,
    });
  }
  if (item.type === "imageView") {
    return agentActivitySchema.parse({
      type: "imageView",
      id: item.id,
      status: lifecycle === "started" ? "running" : "completed",
      path: displayPath(cwd, item.path),
      ...raw,
      ...timestamps,
      correlation,
    });
  }
  if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") {
    return agentActivitySchema.parse({
      type: "reviewMode",
      id: item.id,
      status: lifecycle === "started" ? "running" : "completed",
      state: item.type === "enteredReviewMode" ? "entered" : "exited",
      review: boundedText(item.review) ?? "",
      ...raw,
      ...timestamps,
      correlation,
    });
  }
  if (item.type === "contextCompaction") {
    return agentActivitySchema.parse({
      type: "contextCompaction",
      id: item.id,
      status: lifecycle === "started" ? "running" : "completed",
      ...raw,
      ...timestamps,
      correlation,
    });
  }
  return null;
}

export function normalizeAgentMessage(
  item: AgentMessageItem,
  correlation: CodexEventCorrelation,
): NormalizedAgentMessage | null {
  const text = item.text?.trim();
  if (!text) return null;
  return normalizedAgentMessageSchema.parse({
    id: item.id,
    text,
    phase: item.phase ?? null,
    correlation,
  });
}

export function normalizeTokenUsageActivity(
  params: ThreadTokenUsageUpdatedParams,
  correlation: CodexEventCorrelation,
): AgentActivity {
  const window = params.tokenUsage.modelContextWindow;
  const contextUsedPercent = window
    ? Math.round((params.tokenUsage.last.totalTokens / window) * 1_000) / 10
    : null;
  return agentActivitySchema.parse({
    type: "usage",
    id: `turn:${params.turnId}:usage`,
    status: "completed",
    ...params.tokenUsage,
    contextUsedPercent,
    correlation,
  });
}

export function normalizeRateLimitActivity(
  params: AccountRateLimitsUpdatedParams,
  turnId: string,
  correlation: CodexEventCorrelation,
): AgentActivity {
  return agentActivitySchema.parse({
    type: "rateLimit",
    id: `turn:${turnId}:rate-limit`,
    status: params.rateLimits.rateLimitReachedType ? "failed" : "completed",
    updatedAtMs: Date.now(),
    limitId: params.rateLimits.limitId,
    limitName: params.rateLimits.limitName,
    planType: params.rateLimits.planType,
    reachedType: params.rateLimits.rateLimitReachedType,
    primary: params.rateLimits.primary,
    secondary: params.rateLimits.secondary,
    credits: params.rateLimits.credits,
    correlation,
  });
}

export function normalizeNoticeActivity(input: {
  correlation: CodexEventCorrelation;
  details?: string | null;
  level: "warning" | "error";
  message: string;
  reasonCode?: string | null;
  retry?: {
    owner: "codex" | "cantrip";
    attempt: number | null;
    maxAttempts: number | null;
    nextAttemptAtMs: number | null;
  } | null;
  status?: AgentActivity["status"];
  willRetry?: boolean | null;
}): AgentActivity {
  return agentActivitySchema.parse({
    type: "notice",
    id: stableActivityId(
      input.level,
      input.correlation.turnId,
      input.correlation.sourceMethod,
      input.message,
    ),
    status:
      input.status ??
      (input.willRetry
        ? "running"
        : input.level === "error"
          ? "failed"
          : "completed"),
    level: input.level,
    message: boundedText(input.message)?.trim() || input.level,
    details: boundedText(input.details),
    willRetry: input.willRetry ?? null,
    reasonCode: input.reasonCode ?? null,
    retry: input.retry ?? null,
    correlation: input.correlation,
  });
}

export function turnSummaryActivity(
  turn: Pick<
    CodexThreadTurn,
    "completedAt" | "durationMs" | "id" | "startedAt" | "status"
  >,
  correlation: CodexEventCorrelation,
  initialSettings?: NativeInitialTurnSettings,
): AgentActivity {
  return agentActivitySchema.parse({
    type: "turnSummary",
    id: `turn:${turn.id}:summary`,
    status:
      turn.status === "inProgress"
        ? "running"
        : turn.status === "completed"
          ? "completed"
          : "failed",
    durationMs: turn.durationMs,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    correlation,
    ...(initialSettings ? { initialSettings } : {}),
  });
}

export function normalizeCodexThreadTurn(
  turn: CodexThreadTurn,
  cwd: string,
  threadId: string,
  externalAttachmentIdsByItemId: ReadonlyMap<string, string[]> = new Map(),
): AgentThreadSync["turns"][number] {
  let lastFinalMessageIndex = -1;
  if (turn.status === "completed") {
    for (let index = 0; index < turn.items.length; index += 1) {
      const item = turn.items[index];
      if (
        item?.type === "agentMessage" &&
        item.phase !== "commentary" &&
        item.text?.trim()
      ) {
        lastFinalMessageIndex = index;
      }
    }
  }
  const items = turn.items.flatMap((item, index): AgentThreadSyncItem[] => {
    if (item.type === "userMessage") {
      const text = item.content
        .flatMap((content) =>
          content.type === "text" && content.text ? [content.text] : [],
        )
        .join("\n\n")
        .trim();
      const externalAttachmentIds =
        externalAttachmentIdsByItemId.get(item.id) ?? [];
      return text || externalAttachmentIds.length
        ? [
            {
              type: "userMessage",
              id: item.id,
              text,
              externalAttachmentIds,
            },
          ]
        : [];
    }
    if (item.type === "agentMessage") {
      const message = normalizeAgentMessage(
        item,
        eventCorrelation("thread/read", null, threadId, turn.id, item.id),
      );
      if (!message) return [];
      return [
        {
          type: "agentMessage",
          ...(message.phase !== "commentary" && index !== lastFinalMessageIndex
            ? asCommentary(message)
            : message),
        },
      ];
    }
    const correlation = eventCorrelation(
      "thread/read",
      null,
      threadId,
      turn.id,
      item.id,
    );
    const normalizedActivity = normalizeCodexThreadItem(
      item,
      cwd,
      turn.status === "inProgress" ? "started" : "completed",
      correlation,
    );
    const activity =
      normalizedActivity && turn.status !== "inProgress"
        ? settleRunningActivityAtTurnBoundary(
            normalizedActivity,
            turn.status === "completed" ? "completed" : "failed",
            turn.completedAt === null ? null : turn.completedAt * 1_000,
            correlation,
          )
        : normalizedActivity;
    if (activity) return [{ type: "activity", activity }];
    const unknown = item as { id?: unknown; type?: unknown };
    const itemId = typeof unknown.id === "string" ? unknown.id : null;
    const itemType =
      typeof unknown.type === "string" ? unknown.type : "unknown";
    return [
      {
        type: "activity",
        activity: normalizeNoticeActivity({
          level: "warning",
          message: "An unsupported Codex history item could not be rendered.",
          details: `Item type: ${itemType.slice(0, 200)}`,
          correlation: eventCorrelation(
            "thread/read",
            null,
            threadId,
            turn.id,
            itemId,
          ),
        }),
      },
    ];
  });
  if (turn.error?.message) {
    items.push({
      type: "activity",
      activity: normalizeNoticeActivity({
        level: "error",
        message: turn.error.message,
        details: turn.error.additionalDetails,
        reasonCode: codexErrorReasonCode(turn.error.codexErrorInfo),
        willRetry: false,
        correlation: eventCorrelation(
          "thread/read",
          null,
          threadId,
          turn.id,
          null,
        ),
      }),
    });
  }
  items.push({
    type: "activity",
    activity: turnSummaryActivity(
      turn,
      eventCorrelation("thread/read", null, threadId, turn.id, null),
    ),
  });
  return {
    id: turn.id,
    status: turn.status,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    items,
  };
}

export function normalizeCodexThreadReadResponse(
  response: CodexThreadReadResponse,
  cwd: string,
  externalAttachmentIdsByItemId: ReadonlyMap<string, string[]> = new Map(),
): AgentThreadSync {
  const turns = response.thread.turns.map((turn) =>
    normalizeCodexThreadTurn(
      turn,
      cwd,
      response.thread.id,
      externalAttachmentIdsByItemId,
    ),
  );
  const status = turns.some((turn) => turn.status === "inProgress")
    ? "running"
    : turns.some((turn) => turn.status === "failed")
      ? "failed"
      : "idle";
  return agentThreadSyncSchema.parse({
    threadId: response.thread.id,
    status,
    turns,
  });
}

export function completedCodexThreadTurnFromRead(
  response: CodexThreadReadResponse,
  cwd: string,
  turnId: string,
): AgentThreadSync["turns"][number] | null {
  const turn = response.thread.turns.find(
    (candidate) => candidate.id === turnId && candidate.status !== "inProgress",
  );
  return turn ? normalizeCodexThreadTurn(turn, cwd, response.thread.id) : null;
}
