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
      title: "First chat",
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
        {
          tabKey: "chat:two",
          groupId: "group-1",
          projectId: "project-1",
          tabKind: "chat",
          tabId: "two",
          title: "Chat Two",
          position: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
    {
      id: "group-2",
      projectId: "project-1",
      title: "Terminal",
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
    tabKey: "chat:two",
    tabId: "two",
    projectId: "project-1",
    groupId: "group-1",
    kind: "chat",
    title: "Chat Two",
    entity: { status: "idle" },
    member: layout.groups[0]!.members[1]!,
  },
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
  it("renders flat group choices without expanding their individual tabs", () => {
    const markup = renderToStaticMarkup(
      <MobileProjectTabGrid
        activeGroupId="group-1"
        activeTabByGroup={{ "group-1": "chat:one" }}
        creatingKinds={new Set()}
        layout={layout}
        surfaces={surfaces}
        onCreate={vi.fn()}
        onSelectGroup={vi.fn()}
      />,
    );

    expect(markup).toContain("Group 1");
    expect(markup).toContain("Group 2");
    expect(markup.indexOf("First chat")).toBeLessThan(
      markup.indexOf("Terminal"),
    );
    expect(markup).toContain('aria-label="Open Group 1: First chat"');
    expect(markup).not.toContain("Chat One");
    expect(markup).not.toContain("Chat Two");
    expect(markup).not.toContain("Actions for");
    expect(markup).not.toContain("Remove bottom tab");
  });

  it("offers removal while switching an added bottom tab", () => {
    const markup = renderToStaticMarkup(
      <MobileProjectTabGrid
        activeGroupId="group-2"
        activeTabByGroup={{ "group-2": "terminal:one" }}
        creatingKinds={new Set()}
        layout={layout}
        surfaces={surfaces}
        onCreate={vi.fn()}
        onRemoveBottomTab={vi.fn()}
        onSelectGroup={vi.fn()}
      />,
    );

    expect(markup).toContain("Remove bottom tab");
  });

  it("evenly divides up to five actions including Overview and add", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNavigation
        activeItemId="primary"
        gridOpen={false}
        items={[
          { id: "primary", label: "Agents", surface: surfaces[1] },
          { id: "mobile-1", surface: surfaces[2] },
          { id: "mobile-2", surface: surfaces[1] },
        ]}
        onAdd={vi.fn()}
        onOverview={vi.fn()}
        onReset={vi.fn()}
        onSelect={vi.fn()}
        overviewSelected={false}
      />,
    );

    expect(markup.match(/<button/g)).toHaveLength(5);
    expect(markup).toContain("Overview");
    expect(markup).toContain("Agents");
    expect(markup).toContain("Terminal One");
    expect(markup).toContain('aria-label="Add bottom tab"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('fill="currentColor"');
    expect(markup).toContain('fill="none"');
    expect(markup).toContain('data-layout="equal"');
    expect(markup.match(/min-w-0 flex-1/g)).toHaveLength(5);
    expect(markup).toContain("Hold to choose another project tab group");
  });

  it("switches to self-sized scrolling actions above five total items", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNavigation
        activeItemId="primary"
        gridOpen={false}
        items={[
          { id: "primary", surface: surfaces[1] },
          { id: "mobile-1", surface: surfaces[2] },
          { id: "mobile-2", surface: surfaces[1] },
          { id: "mobile-3", surface: surfaces[2] },
        ]}
        onAdd={vi.fn()}
        onOverview={vi.fn()}
        onReset={vi.fn()}
        onSelect={vi.fn()}
        overviewSelected={false}
      />,
    );

    expect(markup).toContain('data-layout="scroll"');
    expect(markup).toContain("overflow-x-auto");
    expect(markup.match(/min-w-\[4\.5rem\]/g)).toHaveLength(6);
  });

  it("shows Tabs only for the slot whose switcher is active", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNavigation
        activeItemId="primary"
        gridOpen
        items={[
          { id: "primary", surface: surfaces[1] },
          { id: "mobile-1", surface: surfaces[2] },
        ]}
        onAdd={vi.fn()}
        onOverview={vi.fn()}
        onReset={vi.fn()}
        onSelect={vi.fn()}
        overviewSelected={false}
      />,
    );

    expect(markup).toContain("Tabs");
    expect(markup).not.toContain("Chat One");
    expect(markup).toContain("Terminal One");
  });
});
