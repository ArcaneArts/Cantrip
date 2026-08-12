import type { ProjectTabLayoutSummary } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ProjectSurface } from "@/lib/project-surface";

import { MobileBottomNavigation } from "./mobile-bottom-navigation";
import { MobileProjectTabGrid } from "./mobile-project-tab-grid";

const now = "2026-08-11T12:00:00.000Z";
const layout = {
  projectId: "project-1",
  revision: 1,
  groups: [
    {
      id: "group-1",
      projectId: "project-1",
      position: 0,
      anchorTabKey: "chat:one",
      createdAt: now,
      updatedAt: now,
      members: [
        {
          tabKey: "chat:one",
          groupId: "group-1",
          projectId: "project-1",
          tabKind: "chat",
          tabId: "one",
          title: "Chat One",
          position: 0,
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
    {
      id: "group-2",
      projectId: "project-1",
      position: 1,
      anchorTabKey: "terminal:one",
      createdAt: now,
      updatedAt: now,
      members: [
        {
          tabKey: "terminal:one",
          groupId: "group-2",
          projectId: "project-1",
          tabKind: "terminal",
          tabId: "one",
          title: "Terminal One",
          position: 0,
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
  ],
} satisfies ProjectTabLayoutSummary;
const surfaces = [
  {
    tabKey: "chat:one",
    tabId: "one",
    projectId: "project-1",
    groupId: "group-1",
    kind: "chat",
    title: "Chat One",
    entity: { status: "idle" },
    member: layout.groups[0]!.members[0]!,
  },
  {
    tabKey: "terminal:one",
    tabId: "one",
    projectId: "project-1",
    groupId: "group-2",
    kind: "terminal",
    title: "Terminal One",
    entity: { status: "running" },
    member: layout.groups[1]!.members[0]!,
  },
] as ProjectSurface[];

describe("mobile project shell", () => {
  it("renders project surfaces in authoritative group order", () => {
    const markup = renderToStaticMarkup(
      <MobileProjectTabGrid
        creatingKinds={new Set()}
        layout={layout}
        surfaces={surfaces}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onRename={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(markup).toContain("Group 1");
    expect(markup).toContain("Group 2");
    expect(markup.indexOf("Chat One")).toBeLessThan(
      markup.indexOf("Terminal One"),
    );
    expect(markup).toContain('aria-label="Open Chat One"');
    expect(markup).toContain('aria-label="Actions for Terminal One"');
  });

  it("keeps exactly two bottom destinations and adopts surface identity", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNavigation
        gridOpen={false}
        onOverview={vi.fn()}
        onSecondDestination={vi.fn()}
        overviewSelected
        surface={surfaces[0]}
      />,
    );

    expect(markup.match(/<button/g)).toHaveLength(2);
    expect(markup).toContain("Overview");
    expect(markup).toContain("Chat One");
    expect(markup).toContain('aria-current="page"');
  });

  it("shows Tabs while the grid is active", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNavigation
        gridOpen
        onOverview={vi.fn()}
        onSecondDestination={vi.fn()}
        overviewSelected={false}
        surface={surfaces[0]}
      />,
    );

    expect(markup).toContain("Tabs");
    expect(markup).not.toContain("Chat One");
  });
});
