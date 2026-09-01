import type { AgentActivity } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  Activity,
  ActivityGroup,
  CompletedTurnActivityGroup,
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

  it("renders context compaction as a quiet inline lifecycle row", () => {
    const running: AgentActivity = {
      type: "contextCompaction",
      id: "compaction-1",
      status: "running",
    };
    const completed: AgentActivity = {
      ...running,
      status: "completed",
    };

    const runningMarkup = renderToStaticMarkup(<Activity activity={running} />);
    const completedMarkup = renderToStaticMarkup(
      <Activity activity={completed} />,
    );
    expect(activityLabel(running)).toBe("Context automatically compacting");
    expect(activityLabel(completed)).toBe("Context automatically compacted");
    expect(runningMarkup).toContain('data-slot="context-compaction-activity"');
    expect(runningMarkup).toContain("Context automatically compacting");
    expect(runningMarkup).not.toContain("<details");
    expect(runningMarkup).not.toContain("animate-spin");
    expect(completedMarkup).toContain("Context automatically compacted");
    expect(completedMarkup).not.toContain("text-emerald");
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
      "Changed 1 file · +1 more",
    );
    expect(completed).toContain("Changed 1 file · +1 more");
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

    const completedTool = { ...runningTool, status: "completed" } as const;
    const completedToolMarkup = renderToStaticMarkup(
      <ActivityGroup
        active={false}
        activities={[completedTool]}
        turnId="turn-2"
        turnKey="runtime:turn-2"
      />,
    );
    expect(activityGroupSummary([completedTool])).toBe(
      "Called github/search_issues",
    );
    expect(completedToolMarkup).toContain("Called github/search_issues");
    expect(completedToolMarkup).not.toContain("Used a tool");

    expect(
      activityGroupSummary(
        Array.from({ length: 6 }, (_, index) => ({
          ...command,
          id: `command-${index}`,
          command: index === 5 ? "pnpm test" : `command ${index}`,
        })),
      ),
    ).toBe("Ran pnpm test · +5 more");
  });

  it("shows the latest syntax-highlighted file preview in a collapsed live group", () => {
    const fileChange: AgentActivity = {
      type: "fileChange",
      id: "file-live",
      status: "running",
      changes: [
        {
          path: "src/live.ts",
          kind: "update",
          latestLine: "export const live = true;",
          diffPreview:
            "-export const live = false;\n+export const live = true;",
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <ActivityGroup
        active
        activities={[fileChange]}
        turnId="turn-live"
        turnKey="runtime:turn-live"
      />,
    );

    expect(markup).toContain('data-slot="live-file-change-preview"');
    expect(markup).toContain('data-language="typescript"');
    expect(markup).toContain('class="token boolean"');
    expect(markup).toContain(">true</span>");
    expect(markup).toContain('aria-expanded="false"');
  });

  it("collapses completed turn work behind its elapsed time", async () => {
    const completed = (
      <CompletedTurnActivityGroup
        endedAt="2026-08-07T12:00:37.000Z"
        onViewTrajectory={vi.fn()}
        startedAt="2026-08-07T12:00:00.000Z"
        turnId="turn-1"
        turnKey="runtime:turn-1"
      >
        <span>Grouped command</span>
      </CompletedTurnActivityGroup>
    );
    const markup = renderToStaticMarkup(completed);
    expect(markup).toContain("Worked for 37s");
    expect(markup).not.toContain("Grouped command");
    expect(markup).toContain('aria-label="View turn trajectory"');

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(completed);
    });

    expect(JSON.stringify(renderer.toJSON())).not.toContain("Grouped command");
    const disclosure = renderer.root.findByProps({ "aria-expanded": false });
    await act(async () => disclosure.props.onClick());
    expect(renderer.root.findByProps({ "aria-expanded": true })).toBeDefined();
    expect(
      renderer.root.findByProps({ "data-slot": "completed-turn-work" }).props
        .className,
    ).toContain("gap-3");
    expect(JSON.stringify(renderer.toJSON())).toContain("Grouped command");
    await act(async () => renderer.unmount());
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
