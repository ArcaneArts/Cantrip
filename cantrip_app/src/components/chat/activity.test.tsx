import type { AgentActivity } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Activity, activityLabel } from "./activity";

describe("rich Codex activity", () => {
  it("shows the command inside a login-shell wrapper", () => {
    const command = '/bin/zsh -lc "printf \\"hello\\""';
    const activity: AgentActivity = {
      type: "command",
      id: "command-1",
      command,
      cwd: ".",
      status: "completed",
      exitCode: 0,
      output: null,
    };

    const markup = renderToStaticMarkup(<Activity activity={activity} />);
    expect(markup).toContain("printf &quot;hello&quot;");
    expect(markup).not.toContain("/bin/zsh");
    expect(activityLabel(activity)).toBe('printf "hello"');
    expect(activity.command).toBe(command);
  });

  it("renders reasoning summaries inline without a disclosure", () => {
    const activity: AgentActivity = {
      type: "reasoning",
      id: "reasoning-1",
      status: "completed",
      summary: ["Compared the supported runtime methods."],
      correlation: {
        sourceMethod: "item/completed",
        diagnosticId: "session-1:8",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reasoning-1",
      },
    };

    const markup = renderToStaticMarkup(<Activity activity={activity} />);
    expect(markup).toContain("Compared the supported runtime methods.");
    expect(markup).not.toContain("Reasoned");
    expect(markup).not.toContain("&lt;details");
    expect(markup).not.toContain("<details");
    expect(markup).not.toContain("session-1:8");
    expect(markup).not.toContain("private");
  });

  it("provides concise labels for tools, subagents, and usage", () => {
    expect(
      activityLabel({
        type: "mcpToolCall",
        id: "mcp-1",
        status: "completed",
        server: "github",
        tool: "search_issues",
        error: null,
        durationMs: 90,
      }),
    ).toBe("MCP · github/search_issues");
    expect(
      activityLabel({
        type: "subAgent",
        id: "agent-1",
        status: "running",
        kind: "started",
        agentThreadId: "thread-2",
        agentPath: "/root/reviewer",
      }),
    ).toBe("Subagent · /root/reviewer");
    expect(
      activityLabel({
        type: "usage",
        id: "usage-1",
        status: "completed",
        total: {
          totalTokens: 1_234,
          inputTokens: 800,
          cachedInputTokens: 200,
          cacheWriteInputTokens: 0,
          outputTokens: 334,
          reasoningOutputTokens: 100,
        },
        last: {
          totalTokens: 1_234,
          inputTokens: 800,
          cachedInputTokens: 200,
          cacheWriteInputTokens: 0,
          outputTokens: 334,
          reasoningOutputTokens: 100,
        },
        modelContextWindow: 10_000,
        contextUsedPercent: 12.3,
      }),
    ).toBe("Used 1,234 tokens");
  });
});
