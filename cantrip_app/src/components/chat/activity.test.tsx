import type { AgentActivity } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Activity, ActivityGroup, activityLabel } from "./activity";

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

  it("presents CodeGraph queries and results without runtime diagnostics", () => {
    const activity: AgentActivity = {
      type: "mcpToolCall",
      id: "codegraph-1",
      status: "completed",
      server: "codegraph",
      tool: "codegraph_explore",
      query: "Explain what this project does from the code architecture.",
      resultText:
        "**Exploration:** Project architecture\n\nFound 54 symbols across 1 file.",
      error: null,
      durationMs: 233,
      correlation: {
        sourceMethod: "item/completed",
        diagnosticId: "session-1:403",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "codegraph-1",
      },
    };

    const markup = renderToStaticMarkup(<Activity activity={activity} />);
    expect(activityLabel(activity)).toBe(
      "CodeGraph · Explain what this project does from the code architecture.",
    );
    expect(markup).toContain("CodeGraph");
    expect(markup).toContain("Found 54 symbols across 1 file.");
    expect(markup).not.toContain("Runtime source");
    expect(markup).not.toContain("session-1:403");
  });

  it("hides completed turn work behind the elapsed-time disclosure", () => {
    const completed = renderToStaticMarkup(
      <ActivityGroup
        startedAt="2026-08-07T12:00:00.000Z"
        endedAt="2026-08-07T12:00:37.000Z"
        onViewTrajectory={vi.fn()}
        turnId="turn-1"
        turnKey="runtime:turn-1"
      >
        <span>Grouped command</span>
      </ActivityGroup>,
    );
    expect(completed).toContain("Worked for 37s");
    expect(completed).toContain('aria-label="View turn trajectory"');
    expect(completed.match(/<button/gu)).toHaveLength(2);
    expect(completed).toContain('data-turn-key="runtime:turn-1"');
    expect(completed).not.toContain("Grouped command");

    const running = renderToStaticMarkup(
      <ActivityGroup
        startedAt="2026-08-07T12:00:00.000Z"
        endedAt={null}
        turnId={null}
        turnKey="legacy:user-1"
      >
        <span>Running command</span>
      </ActivityGroup>,
    );
    expect(running).toContain("Running command");
    expect(running).toContain('data-turn-key="legacy:user-1"');
    expect(running).not.toContain("Worked for");
  });
});
