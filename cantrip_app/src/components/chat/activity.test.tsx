import type { AgentActivity } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  Activity,
  ActivityGroup,
  activityGroupSummary,
  activityLabel,
  latestActivityLabel,
} from "./activity";

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

  it("keeps failed MCP cards collapsed with their details available", () => {
    const activity: AgentActivity = {
      type: "mcpToolCall",
      id: "cantrip-failure",
      status: "failed",
      server: "cantrip",
      tool: "worktree_create",
      query: null,
      resultText: null,
      error: "Unrecognized key: from. Use baseRevision.",
      errorCode: "-32602",
      retryable: false,
      durationMs: null,
    };
    const markup = renderToStaticMarkup(<Activity activity={activity} />);
    expect(markup).toContain("<details");
    expect(markup).not.toContain("<details open");
    expect(markup).toContain("Unrecognized key: from. Use baseRevision.");
    expect(markup).toContain("Error code");
    expect(markup).toContain("-32602");
    expect(markup).toContain("should not be retried unchanged");
  });

  it("keeps failed command output collapsed", () => {
    const activity: AgentActivity = {
      type: "command",
      id: "command-failure",
      command: "pnpm test",
      cwd: ".",
      status: "failed",
      exitCode: 1,
      output: "Tests failed",
    };

    const markup = renderToStaticMarkup(<Activity activity={activity} />);
    expect(markup).toContain("<details");
    expect(markup).not.toContain("<details open");
    expect(markup).toContain("Tests failed");
    expect(markup).toContain("Exit code 1");
  });

  it("summarizes completed tool groups and shimmers only the latest live work", () => {
    const command: AgentActivity = {
      type: "command",
      id: "command-1",
      command: "git status --short",
      cwd: ".",
      status: "completed",
      exitCode: 0,
      output: null,
    };
    const fileChange: AgentActivity = {
      type: "fileChange",
      id: "file-1",
      status: "completed",
      changes: [{ path: "src/App.tsx", kind: "update" }],
    };
    const completed = renderToStaticMarkup(
      <ActivityGroup
        active={false}
        activities={[command, fileChange]}
        onViewTrajectory={vi.fn()}
        turnId="turn-1"
        turnKey="runtime:turn-1"
      />,
    );
    expect(activityGroupSummary([command, fileChange])).toBe(
      "Ran a command, edited files",
    );
    expect(completed).toContain("Ran a command, edited files");
    expect(completed).toContain('aria-label="View turn trajectory"');
    expect(completed.match(/<button/gu)).toHaveLength(2);
    expect(completed).toContain('data-turn-key="runtime:turn-1"');
    expect(completed).not.toContain("chat-working-shimmer");
    expect(completed).not.toContain("git status --short");

    const runningTool: AgentActivity = {
      type: "mcpToolCall",
      id: "tool-1",
      status: "running",
      server: "github",
      tool: "search_issues",
      error: null,
      durationMs: null,
    };
    const running = renderToStaticMarkup(
      <ActivityGroup
        active
        activities={[command, runningTool]}
        turnId={null}
        turnKey="legacy:user-1"
      />,
    );
    expect(latestActivityLabel(runningTool)).toBe(
      "Calling github/search_issues",
    );
    expect(running).toContain("Calling github/search_issues");
    expect(running.match(/chat-working-shimmer/gu)).toHaveLength(1);
    expect(running).toContain('data-turn-key="legacy:user-1"');
    expect(running).not.toContain("git status --short");
  });

  it("expands a tool group into a bounded scrollable activity list", async () => {
    const activities: AgentActivity[] = [
      {
        type: "command",
        id: "command-1",
        command: "git status --short",
        cwd: ".",
        status: "completed",
        exitCode: 0,
        output: null,
      },
      {
        type: "command",
        id: "command-2",
        command: "pnpm test",
        cwd: ".",
        status: "completed",
        exitCode: 0,
        output: null,
      },
    ];
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ActivityGroup
          active={false}
          activities={activities}
          turnId="turn-1"
          turnKey="runtime:turn-1"
        />,
      );
    });
    const disclosure = renderer.root.findByProps({ "aria-expanded": false });
    await act(async () => disclosure.props.onClick());
    expect(renderer.root.findByProps({ "aria-expanded": true })).toBeDefined();
    const scrollRegion = renderer.root.find(
      (node) =>
        typeof node.props.className === "string" &&
        node.props.className.includes("max-h-64") &&
        node.props.className.includes("overflow-y-auto"),
    );
    expect(scrollRegion).toBeDefined();
    expect(JSON.stringify(renderer.toJSON())).toContain("git status --short");
    expect(JSON.stringify(renderer.toJSON())).toContain("pnpm test");
    await act(async () => renderer.unmount());
  });
});
