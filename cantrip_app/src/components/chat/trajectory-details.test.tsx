import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TrajectoryDetails } from "./trajectory-details";
import type { TrajectoryEvent } from "./trajectory-model";

function event(): TrajectoryEvent {
  return {
    activity: {
      type: "command",
      id: "command-1",
      status: "completed",
      command: "pnpm test",
      cwd: "/workspace",
      exitCode: 0,
      output: null,
      outputTail: "Tests passed",
      outputTruncated: true,
      durationMs: 250,
      raw: {
        schemaVersion: 1,
        request: {
          mediaType: "application/json",
          text: '{"command":"pnpm test"}',
          originalBytes: 23,
          truncated: false,
        },
        response: null,
        metadata: { itemType: "commandExecution" },
      },
      correlation: {
        sourceMethod: "item/completed",
        diagnosticId: "diagnostic-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
      },
    },
    agentDepth: 0,
    agentIsRoot: true,
    agentKey: "root",
    agentLabel: "Root agent",
    completedAtMs: 1_250,
    contentIndex: 0,
    diagnosticId: "diagnostic-1",
    focusItemKey: null,
    id: "event-1",
    itemId: "command-1",
    kind: "command",
    label: "Command · pnpm test",
    lane: "tools",
    messageId: "message-1",
    preview: "Tests passed",
    searchableText: "command pnpm test Tests passed",
    sequence: 1,
    startMs: 1_000,
    status: "completed",
    threadId: "thread-1",
    timingQuality: "exact",
    turnId: "turn-1",
    updatedAtMs: 1_250,
  };
}

describe("TrajectoryDetails", () => {
  it("shows correlated summary details by default", () => {
    const markup = renderToStaticMarkup(
      <TrajectoryDetails event={event()} onBack={() => undefined} />,
    );
    expect(markup).toContain("Summary details");
    expect(markup).toContain("Root agent");
    expect(markup).toContain("diagnostic-1");
    expect(markup).toContain("item/completed");
    expect(markup).toContain("250 ms");
  });

  it("renders a useful command preview", () => {
    const markup = renderToStaticMarkup(
      <TrajectoryDetails
        event={event()}
        initialTab="preview"
        onBack={() => undefined}
      />,
    );
    expect(markup).toContain("Preview details");
    expect(markup).toContain("Older output was truncated");
    expect(markup).toContain("Tests passed");
  });

  it("renders non-command previews as Markdown", () => {
    const previewEvent = event();
    previewEvent.activity = {
      type: "reasoning",
      id: "reasoning-1",
      status: "completed",
      summary: ["A **stable** preview"],
    };
    previewEvent.kind = "reasoning";

    const markup = renderToStaticMarkup(
      <TrajectoryDetails
        event={previewEvent}
        initialTab="preview"
        onBack={() => undefined}
      />,
    );

    expect(markup).toContain("A <strong>stable</strong> preview");
  });

  it("renders file changes as syntax-highlighted diff previews", () => {
    const previewEvent = event();
    previewEvent.activity = {
      type: "fileChange",
      id: "files-1",
      status: "running",
      changes: [
        {
          path: "src/preview.ts",
          kind: "update",
          latestLine: "const current = true;",
          diffPreview: "-const current = false;\n+const current = true;",
        },
      ],
    };
    previewEvent.kind = "fileChange";

    const markup = renderToStaticMarkup(
      <TrajectoryDetails
        event={previewEvent}
        initialTab="preview"
        onBack={() => undefined}
      />,
    );

    expect(markup).toContain('data-slot="file-change-preview"');
    expect(markup).toContain('data-language="typescript"');
    expect(markup).toContain('class="token boolean"');
    expect(markup).toContain(">true</span>");
  });

  it("keeps the bounded protected envelope in Raw", () => {
    const markup = renderToStaticMarkup(
      <TrajectoryDetails
        event={event()}
        initialTab="raw"
        onBack={() => undefined}
      />,
    );
    expect(markup).toContain("Raw details");
    expect(markup).toContain("Normalized event");
    expect(markup).toContain("Protected capture");
    expect(markup).toContain("pnpm test");
  });
});
