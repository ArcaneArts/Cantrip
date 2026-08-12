import type { TerminalSummary } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TerminalServicePanel } from "./terminal-service-panel";

describe("TerminalServicePanel", () => {
  it("shows the persisted service command and process controls", () => {
    const now = "2026-08-11T12:00:00.000Z";
    const terminal = {
      id: "terminal-1",
      projectId: "project-1",
      title: "Redis",
      position: 0,
      status: "running",
      activeWorkerId: "worker-1",
      worktreeId: "worktree-1",
      linkedChatId: null,
      service: { enabled: true, command: "redis-server" },
      createdAt: now,
      updatedAt: now,
    } satisfies TerminalSummary;
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <TerminalServicePanel onClose={vi.fn()} terminal={terminal} />
      </QueryClientProvider>,
    );

    expect(markup).toContain('aria-label="Terminal service"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain("redis-server");
    expect(markup).toContain("five-second cooldown");
    expect(markup).toContain("Restart</button>");
  });
});
