import type { ChatSummary } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AGENT_INSPECT_THOUGHT_LINE_LIMIT,
  AGENT_INSPECT_SCROLLING_CARD_HEIGHT_PX,
  AgentInspectContent,
  AgentInspectPresentation,
  agentInspectorActive,
  commandOutputIsAtBottom,
  formatInspectorElapsed,
  inspectorCommandLayout,
  inspectorSingleLine,
  latestInspectorThoughtLines,
  visibleInspectorCommands,
} from "./agent-inspect-content";
import type {
  AgentInspectorCommand,
  AgentInspectorSnapshot,
} from "./inspect-model";

function command(
  id: string,
  presentation: AgentInspectorCommand["presentation"] = "visible",
): AgentInspectorCommand {
  return {
    id,
    command: `pnpm run ${id}`,
    completedAtMs: null,
    cwd: ".",
    elapsedMs: 62_000,
    exitCode: null,
    output: `output from ${id}`,
    outputTruncated: false,
    presentation,
    startedAtMs: 1_000,
    status: "running",
    turnId: "turn-1",
    updatedAtMs: 2_000,
  };
}

function snapshot(
  input: Partial<AgentInspectorSnapshot> = {},
): AgentInspectorSnapshot {
  return {
    active: true,
    commands: [],
    files: [],
    nextTransitionAtMs: null,
    recentCommands: [],
    thought: null,
    turnId: "turn-1",
    ...input,
  };
}

describe("agent inspector presentation helpers", () => {
  it("only treats live and approval-blocked turns as active", () => {
    const statuses: ChatSummary["status"][] = [
      "idle",
      "running",
      "waiting-for-approval",
      "offline",
      "failed",
    ];
    expect(statuses.map(agentInspectorActive)).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
  });

  it("formats the shared stopwatch without per-card timers", () => {
    expect(formatInspectorElapsed(-1)).toBe("0:00");
    expect(formatInspectorElapsed(9_999)).toBe("0:09");
    expect(formatInspectorElapsed(62_000)).toBe("1:02");
    expect(formatInspectorElapsed(3_661_000)).toBe("1:01:01");
  });

  it("keeps commands and file previews on one visual line", () => {
    expect(inspectorSingleLine("first\r\nsecond\nthird")).toBe(
      "first ↵ second ↵ third",
    );
  });

  it("limits live thinking to its latest three meaningful lines", () => {
    expect(AGENT_INSPECT_THOUGHT_LINE_LIMIT).toBe(3);
    expect(
      latestInspectorThoughtLines(
        "oldest\r\nolder\n\nrecent one\nrecent two\nrecent three",
      ),
    ).toBe("recent one\nrecent two\nrecent three");
  });

  it("follows output only while its viewport remains at the newest end", () => {
    expect(
      commandOutputIsAtBottom({
        clientHeight: 100,
        scrollHeight: 500,
        scrollTop: 376,
      }),
    ).toBe(true);
    expect(
      commandOutputIsAtBottom({
        clientHeight: 100,
        scrollHeight: 500,
        scrollTop: 375,
      }),
    ).toBe(false);
  });

  it("filters threshold-hidden cards and selects the required layouts", () => {
    expect(
      visibleInspectorCommands([
        command("hidden", "hidden"),
        command("visible"),
        command("exiting", "exiting"),
      ]).map(({ id }) => id),
    ).toEqual(["visible", "exiting"]);
    expect(inspectorCommandLayout(3)).toEqual({
      cardHeight: "calc((100% - 1rem) / 3)",
      scrollable: false,
    });
    expect(inspectorCommandLayout(4)).toEqual({
      cardHeight: `${AGENT_INSPECT_SCROLLING_CARD_HEIGHT_PX}px`,
      scrollable: true,
    });
  });
});

describe("AgentInspectPresentation", () => {
  it("renders visible thought, file previews, recent commands, and bounded output state", () => {
    const running = {
      ...command("serve"),
      command: '/bin/zsh -lc "pnpm dev --filter <unsafe>"',
      output: "latest output\ncontinues",
      outputTruncated: true,
    };
    const markup = renderToStaticMarkup(
      <AgentInspectPresentation
        snapshot={snapshot({
          commands: [command("too-fast", "hidden"), running],
          files: [
            {
              id: "file-1",
              expiresAtMs: 12_000,
              kind: "update",
              latestLine: "const latest = '<safe>';",
              path: "src/path with spaces.ts",
              turnId: "turn-1",
              updatedAtMs: 2_000,
            },
            {
              id: "file-2",
              expiresAtMs: 12_000,
              kind: "delete",
              latestLine: null,
              path: "assets/old image.png",
              turnId: "turn-1",
              updatedAtMs: 2_000,
            },
          ],
          recentCommands: [
            {
              id: "quick",
              command: "git status --short",
              completedAtMs: 2_000,
              expiresAtMs: 5_000,
              status: "completed",
              turnId: "turn-1",
            },
          ],
          thought: {
            id: "thought-1",
            kind: "commentary",
            text: [
              "Old thought that should no longer be visible.",
              "Checking the live worker state.",
              "Reviewing the latest command.",
              "Waiting for its result.",
            ].join("\n"),
            turnId: "turn-1",
            updatedAtMs: 1_500,
          },
        })}
      />,
    );

    expect(markup).toContain("Latest thought");
    expect(markup).not.toContain(
      "Old thought that should no longer be visible.",
    );
    expect(markup).toContain("Checking the live worker state.");
    expect(markup).toContain("Reviewing the latest command.");
    expect(markup).toContain("Waiting for its result.");
    expect(markup).toContain("line-clamp-3");
    expect(markup).toContain("src/path with spaces.ts");
    expect(markup).toContain("const latest = &#x27;&lt;safe&gt;&#x27;;");
    expect(markup).toContain("File deleted");
    expect(markup).toContain("overflow-x-auto");
    expect(markup).toContain("whitespace-pre");
    expect(markup).toContain("git status --short");
    expect(markup).toContain("latest 256 KiB retained");
    expect(markup).toContain("latest output");
    expect(markup).not.toContain("too-fast");
    expect(markup).toContain("pnpm dev --filter &lt;unsafe&gt;");
    expect(markup).not.toContain("/bin/zsh");
  });

  it("splits one to three cards evenly and scrolls four or more", () => {
    const equalMarkup = renderToStaticMarkup(
      <AgentInspectPresentation
        snapshot={snapshot({
          commands: [command("one"), command("two"), command("three")],
        })}
      />,
    );
    expect(equalMarkup).toContain('data-command-layout="equal"');
    expect(
      equalMarkup.match(/height:calc\(\(100% - 1rem\) \/ 3\)/gu),
    ).toHaveLength(3);

    const scrollMarkup = renderToStaticMarkup(
      <AgentInspectPresentation
        snapshot={snapshot({
          commands: [
            command("one"),
            command("two"),
            command("three"),
            command("four"),
          ],
        })}
      />,
    );
    expect(scrollMarkup).toContain('data-command-layout="scroll"');
    expect(scrollMarkup).toContain("overflow-y-auto");
    expect(scrollMarkup.match(/height:176px/gu)).toHaveLength(4);
  });

  it("shows a stable active placeholder while telemetry has not arrived", () => {
    const markup = renderToStaticMarkup(
      <AgentInspectPresentation snapshot={snapshot()} />,
    );
    expect(markup).toContain("Watching live activity");
    expect(markup).not.toContain("Inactive");
  });
});

describe("AgentInspectContent", () => {
  it("keeps only the lightweight state shell mounted while hidden", () => {
    const markup = renderToStaticMarkup(
      <AgentInspectContent active messages={[]} visible={false} />,
    );
    expect(markup).toContain('data-slot="agent-observation-content"');
    expect(markup).not.toContain('aria-label="Inspect view"');
    expect(markup).not.toContain('data-slot="agent-trajectory-empty"');
    expect(markup).not.toContain('data-slot="agent-trajectory-content"');
    expect(markup).not.toContain('data-slot="agent-inspect-inactive"');
  });

  it("renders Trajectory first and selects it by default", () => {
    const markup = renderToStaticMarkup(
      <AgentInspectContent active={false} messages={[]} visible />,
    );
    expect(markup.indexOf("Trajectory")).toBeLessThan(markup.indexOf("State"));
    expect(markup).toContain('aria-label="Inspect view"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('aria-label="Trajectory view"');
    expect(markup).toContain('data-slot="agent-trajectory-empty"');
    expect(markup).not.toContain('data-slot="agent-inspect-inactive"');
  });

  it("moves the inactive gate into the State tab", () => {
    const markup = renderToStaticMarkup(
      <AgentInspectContent active={false} messages={[]} tab="state" visible />,
    );
    expect(markup).toContain('aria-label="State view"');
    expect(markup).toContain('data-slot="agent-inspect-inactive"');
    expect(markup).toContain("Shows activity when agent is working");
  });

  it("reserves the shared panel header space within the tab row", () => {
    const markup = renderToStaticMarkup(
      <AgentInspectContent
        active={false}
        integratedPanelHeader
        messages={[]}
        visible
      />,
    );
    expect(markup).toContain("h-11");
    expect(markup).toContain("pl-24");
    expect(markup).toContain("pr-10");
  });
});
