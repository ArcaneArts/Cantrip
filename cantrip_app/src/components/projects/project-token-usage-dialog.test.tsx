import type { ProjectTokenUsage } from "@cantrip/protocol";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/dialog", async () => {
  const React = await import("react");
  const Container = ({
    children,
    className,
  }: {
    children?: React.ReactNode;
    className?: string;
  }) => React.createElement("div", { className }, children);
  return {
    Dialog: Container,
    DialogClose: (props: React.ComponentProps<"button">) =>
      React.createElement("button", props),
    DialogContent: Container,
    DialogDescription: (props: React.ComponentProps<"p">) =>
      React.createElement("p", props),
    DialogHeader: Container,
    DialogTitle: (props: React.ComponentProps<"h2">) =>
      React.createElement("h2", props),
  };
});

import {
  ProjectTokenUsageAnalytics,
  ProjectTokenUsageDialog,
} from "./project-token-usage-dialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const usage = {
  agentTime: {
    activeAgentCount: 0,
    agentTimeMs: 120_000,
    wallTimeMs: 60_000,
    averageConcurrency: 2,
  },
  total: {
    inputTokens: 77_300,
    outputTokens: 992,
    cachedInputTokens: 62_500,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 399,
    totalTokens: 78_292,
  },
  daily: [
    {
      date: "2026-08-29",
      inputTokens: 77_300,
      outputTokens: 992,
      cachedInputTokens: 62_500,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 399,
      totalTokens: 78_292,
    },
  ],
  providers: [
    {
      id: "chatgpt",
      name: "ChatGPT",
      inputTokens: 43_900,
      outputTokens: 500,
      cachedInputTokens: 30_000,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 200,
      totalTokens: 44_600,
      agentTime: {
        activeAgentCount: 0,
        agentTimeMs: 60_000,
        wallTimeMs: 60_000,
        averageConcurrency: 1,
      },
    },
  ],
  models: [
    {
      id: "gpt-5.6-terra",
      name: "gpt-5.6-terra",
      inputTokens: 43_900,
      outputTokens: 500,
      cachedInputTokens: 30_000,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 200,
      totalTokens: 44_600,
      agentTime: {
        activeAgentCount: 0,
        agentTimeMs: 60_000,
        wallTimeMs: 60_000,
        averageConcurrency: 1,
      },
    },
  ],
  range: { start: "2025-08-30", end: "2026-08-29" },
} satisfies ProjectTokenUsage;

function textContent(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (value && typeof value === "object" && "props" in value) {
    return textContent(
      (value as { props: { children?: ReactNode } }).props.children,
    );
  }
  return "";
}

describe("project token usage dialog", () => {
  it("keeps a large mobile close target outside the scrolling content", () => {
    const markup = renderToStaticMarkup(
      <ProjectTokenUsageDialog
        onOpenChange={vi.fn()}
        open
        projectName="Iris"
        usage={usage}
      />,
    );

    expect(markup).toContain('aria-label="Close token usage"');
    expect(markup).toContain("size-10");
    expect(markup).toContain("grid-rows-[auto_minmax(0,1fr)]");
    expect(markup).toContain("overflow-hidden");
  });

  it("uses fixed-width tabs and never exposes a horizontal content scroller", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(ProjectTokenUsageAnalytics, { usage }),
      );
    });

    const tabs = renderer.root.findAllByProps({ role: "tab" });
    expect(tabs.map((tab) => textContent(tab.props.children))).toEqual([
      "Overview",
      "Activity",
      "Breakdowns",
    ]);
    expect(tabs.filter((tab) => tab.props["aria-selected"])).toHaveLength(1);
    expect(
      renderer.root.findAll(
        (node) =>
          typeof node.props.className === "string" &&
          node.props.className.includes("overflow-x-auto"),
      ),
    ).toHaveLength(0);
    expect(
      renderer.root.find(
        (node) =>
          typeof node.props.className === "string" &&
          node.props.className.includes("overflow-y-auto") &&
          node.props.className.includes("overflow-x-hidden"),
      ),
    ).toBeDefined();

    await act(async () => tabs[1]?.props.onClick());
    expect(
      renderer.root
        .findAllByType("h3")
        .some(
          (heading) => textContent(heading.props.children) === "Daily activity",
        ),
    ).toBe(true);
    const calendar = renderer.root.findByProps({
      "aria-label": "Daily token usage",
    });
    expect(calendar.props.className).toContain("auto-cols-fr");
    expect(calendar.props.className).not.toContain("w-max");

    await act(async () =>
      renderer.root.findAllByProps({ role: "tab" })[2]?.props.onClick(),
    );
    const breakdownHeadings = renderer.root
      .findAllByType("h3")
      .map((heading) => textContent(heading.props.children));
    expect(breakdownHeadings).toContain("By provider");
    expect(breakdownHeadings).toContain("AI time by model");
    await act(async () => renderer.unmount());
  });
});
