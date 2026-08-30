import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ProjectSurface } from "@/lib/project-surface";

import { MobileBottomNavigation } from "./mobile-bottom-navigation";

function surface(
  tabKey: string,
  kind: "chat" | "terminal",
  title: string,
): ProjectSurface {
  return {
    entity:
      kind === "chat"
        ? { experience: "chat", status: "idle" }
        : { status: "running" },
    groupId: `group-${tabKey}`,
    kind,
    member: {},
    projectId: "project-1",
    tabId: tabKey.split(":")[1]!,
    tabKey,
    title,
  } as ProjectSurface;
}

const surfaces = [
  surface("chat:one", "chat", "Chat One"),
  surface("terminal:one", "terminal", "Terminal One"),
  surface("chat:two", "chat", "Chat Two"),
];

describe("mobile project navigation", () => {
  it("renders flat project surfaces without tab groups or selector slots", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNavigation
        activeTabKey="terminal:one"
        creatingKinds={new Set()}
        onCreate={vi.fn()}
        onOverview={vi.fn()}
        onSelect={vi.fn()}
        overviewSelected={false}
        surfaces={surfaces}
      />,
    );

    expect(markup).toContain("Chat One");
    expect(markup).toContain("Terminal One");
    expect(markup).toContain('aria-label="Open Terminal One"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('aria-label="Create project surface"');
    expect(markup).not.toContain("Project tabs");
    expect(markup).not.toContain("tab group");
    expect(markup).not.toContain(">Tabs<");
    expect(markup).not.toContain("Remove bottom tab");
  });

  it("evenly divides up to five actions including Overview and create", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNavigation
        activeTabKey="terminal:one"
        creatingKinds={new Set()}
        onCreate={vi.fn()}
        onOverview={vi.fn()}
        onSelect={vi.fn()}
        overviewSelected={false}
        surfaces={surfaces}
      />,
    );

    expect(markup.match(/<button/g)).toHaveLength(5);
    expect(markup).toContain('data-layout="equal"');
    expect(markup.match(/min-w-0 flex-1/g)).toHaveLength(5);
  });

  it("uses a horizontal flat list when more than five actions are open", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNavigation
        activeTabKey={null}
        creatingKinds={new Set()}
        onCreate={vi.fn()}
        onOverview={vi.fn()}
        onSelect={vi.fn()}
        overviewSelected
        surfaces={[
          ...surfaces,
          surface("terminal:two", "terminal", "Terminal Two"),
        ]}
      />,
    );

    expect(markup).toContain('data-layout="scroll"');
    expect(markup).toContain("overflow-x-auto");
    expect(markup.match(/min-w-\[4\.5rem\]/g)).toHaveLength(6);
  });
});
