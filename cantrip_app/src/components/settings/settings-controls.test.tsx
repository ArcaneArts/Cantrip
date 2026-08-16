import { Cable, SlidersHorizontal } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SettingsSearchField, SettingsTabBar } from "./settings-controls";

const tabs = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "mcp", label: "MCP", icon: Cable },
] as const;

describe("shared settings controls", () => {
  it("renders a labeled tablist with one active tab", () => {
    const markup = renderToStaticMarkup(
      <SettingsTabBar
        activeTab="mcp"
        ariaLabel="Account settings sections"
        tabs={tabs}
        onTabChange={vi.fn()}
      />,
    );

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-label="Account settings sections"');
    expect(markup).toContain('aria-selected="false"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain("overflow-x-auto");
    expect(markup).toContain("overflow-y-hidden");
    expect(markup).toContain("[scrollbar-width:none]");
    expect(markup).toContain("shrink-0");
    expect(markup).toContain("General");
    expect(markup).toContain("MCP");
  });

  it("renders an empty search field without a clear action", () => {
    const markup = renderToStaticMarkup(
      <SettingsSearchField
        ariaLabel="Search project settings"
        placeholder="Search project settings"
        value=""
        onValueChange={vi.fn()}
      />,
    );

    expect(markup).toContain('role="searchbox"');
    expect(markup).toContain('aria-label="Search project settings"');
    expect(markup).toContain('placeholder="Search project settings"');
    expect(markup).not.toContain("Clear search");
  });

  it("renders the shared clear action for a populated search", () => {
    const markup = renderToStaticMarkup(
      <SettingsSearchField
        ariaLabel="Search skills"
        placeholder="Search skills"
        value="tooling"
        onValueChange={vi.fn()}
      />,
    );

    expect(markup).toContain('value="tooling"');
    expect(markup).toContain("Clear search");
  });
});
