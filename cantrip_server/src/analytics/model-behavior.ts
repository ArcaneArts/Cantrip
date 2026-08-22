import type { AgentActivity } from "@cantrip/protocol";

const TOOL_ACTIVITY_TYPES = new Set<AgentActivity["type"]>([
  "command",
  "mcpToolCall",
  "dynamicToolCall",
  "collabToolCall",
  "webSearch",
  "imageView",
]);

const TEST_COMMAND_PATTERN =
  /(?:^|[;&|]\s*|\s)(?:(?:pnpm|npm|yarn|bun)(?:\s+[^;&|]+)*\s+(?:test|check)(?:\s|$)|vitest(?:\s|$)|jest(?:\s|$)|pytest(?:\s|$)|cargo\s+test(?:\s|$)|go\s+test(?:\s|$)|mvn(?:\s+[^;&|]+)*\s+test(?:\s|$)|(?:\.\/)?gradlew?(?:\s+[^;&|]+)*\s+test(?:\s|$)|dotnet\s+test(?:\s|$))/iu;

export function isObservedTestCommand(command: string): boolean {
  return TEST_COMMAND_PATTERN.test(command);
}

function toolFailed(activity: AgentActivity): boolean {
  if (activity.status === "failed" || activity.status === "declined") {
    return true;
  }
  if (activity.type === "command") {
    return activity.exitCode !== null && activity.exitCode !== 0;
  }
  if (activity.type === "mcpToolCall") return activity.error !== null;
  if (activity.type === "dynamicToolCall") return activity.success === false;
  return false;
}

export interface ModelBehaviorSnapshot {
  firstActivityAt: Date | null;
  firstVisibleResponseAt: Date | null;
  finalAnswerAppeared: boolean;
  toolCallCount: number;
  invalidToolCallCount: number;
  compactionCount: number;
  approvalRequestCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  modelContextWindow: number | null;
  contextUsedPercent: number | null;
  filesChangedCount: number;
  testCommandCount: number;
  testPassCount: number;
  testFailureCount: number;
}

export interface ModelBehaviorUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  modelContextWindow: number | null;
  contextUsedPercent: number | null;
}

/**
 * Reduces the live Codex event stream into content-free behavioral counters.
 * Activity IDs are retained only in memory to avoid counting streamed updates
 * more than once; command text and model output are never persisted here.
 */
export class ModelBehaviorTracker {
  #approvalIds = new Set<string>();
  #compactionIds = new Set<string>();
  #filePaths = new Set<string>();
  #firstActivityAt: Date | null = null;
  #firstVisibleResponseAt: Date | null = null;
  #finalAnswerAppeared = false;
  #tests = new Map<string, { failed: boolean; terminal: boolean }>();
  #tools = new Map<string, boolean>();
  #usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    modelContextWindow: null as number | null,
    contextUsedPercent: null as number | null,
  };

  markActivity(at = new Date()): void {
    this.#firstActivityAt ??= at;
  }

  markVisibleResponse(finalAnswer: boolean, at = new Date()): void {
    this.markActivity(at);
    this.#firstVisibleResponseAt ??= at;
    if (finalAnswer) this.#finalAnswerAppeared = true;
  }

  markApproval(requestKey: string, at = new Date()): void {
    this.markActivity(at);
    this.#approvalIds.add(requestKey);
  }

  observeActivity(activity: AgentActivity, at = new Date()): void {
    if (activity.type === "usage") {
      this.observeUsage(
        {
          inputTokens: activity.last.inputTokens,
          cachedInputTokens: activity.last.cachedInputTokens,
          cacheWriteInputTokens: activity.last.cacheWriteInputTokens,
          outputTokens: activity.last.outputTokens,
          reasoningOutputTokens: activity.last.reasoningOutputTokens,
          modelContextWindow: activity.modelContextWindow,
          contextUsedPercent: activity.contextUsedPercent,
        },
        at,
      );
      return;
    }
    this.markActivity(at);
    if (TOOL_ACTIVITY_TYPES.has(activity.type)) {
      this.#tools.set(activity.id, toolFailed(activity));
    }
    if (
      activity.type === "command" &&
      isObservedTestCommand(activity.command)
    ) {
      this.#tests.set(activity.id, {
        failed: toolFailed(activity),
        terminal:
          activity.status === "completed" ||
          activity.status === "failed" ||
          activity.status === "declined",
      });
    }
    if (activity.type === "fileChange") {
      for (const change of activity.changes) this.#filePaths.add(change.path);
    }
    if (activity.type === "contextCompaction") {
      this.#compactionIds.add(activity.id);
    }
  }

  observeUsage(usage: ModelBehaviorUsage, at = new Date()): void {
    this.markActivity(at);
    this.#usage = { ...usage };
  }

  snapshot(): ModelBehaviorSnapshot {
    const tests = [...this.#tests.values()];
    return {
      firstActivityAt: this.#firstActivityAt,
      firstVisibleResponseAt: this.#firstVisibleResponseAt,
      finalAnswerAppeared: this.#finalAnswerAppeared,
      toolCallCount: this.#tools.size,
      invalidToolCallCount: [...this.#tools.values()].filter(Boolean).length,
      compactionCount: this.#compactionIds.size,
      approvalRequestCount: this.#approvalIds.size,
      ...this.#usage,
      filesChangedCount: this.#filePaths.size,
      testCommandCount: tests.length,
      testPassCount: tests.filter(({ failed, terminal }) => terminal && !failed)
        .length,
      testFailureCount: tests.filter(
        ({ failed, terminal }) => terminal && failed,
      ).length,
    };
  }
}
