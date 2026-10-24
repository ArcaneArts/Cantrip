import type { ProjectSurface } from "@/lib/project-surface";
import type { ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MobileSurfacePicker } from "./mobile-surface-picker";

vi.mock("@/components/mobile/mobile-navigation-haptics", () => ({
  performMobileNavigationHaptic: vi.fn(),
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div data-dialog-content>{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const overview = {
  entity: { definitionId: "project.overview" },
  kind: "builtin",
  tabKey: "builtin:overview",
  title: "Overview",
} as ProjectSurface;
const chat = {
  entity: { experience: "chat" },
  kind: "chat",
  tabKey: "chat:one",
  title: "Agent One",
} as unknown as ProjectSurface;

function picker(overrides: Record<string, unknown> = {}) {
  return (
    <MobileSurfacePicker
      activeTabKey="chat:one"
      creatingKinds={new Set()}
      onArchiveSurface={vi.fn()}
      onCloseSurface={vi.fn()}
      onCreate={vi.fn()}
      onOpenChange={vi.fn()}
      onOverview={vi.fn()}
      onSelect={vi.fn()}
      open
      overviewSelected={false}
      projectName="Cantrip"
      surfaces={[overview, chat]}
      {...overrides}
    />
  );
}

describe("MobileSurfacePicker", () => {
  it.each([true, false])(
    "offers a separate Keep Open target only for preview=%s",
    async (preview) => {
      const file = {
        kind: "file",
        preview,
        title: "first.ts",
        tabKey: "view-id",
        tabId: "document-id",
      } as ProjectSurface;
      const onKeepOpen = vi.fn();
      const onSelect = vi.fn();
      const onCloseSurface = vi.fn();
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(
          picker({ surfaces: [file], onKeepOpen, onSelect, onCloseSurface }),
        );
      });
      const buttons = renderer.root
        .findAllByType("button")
        .filter(
          (button) => button.props["aria-label"] === "Keep first.ts open",
        );
      expect(buttons).toHaveLength(preview ? 1 : 0);
      if (preview) {
        await act(async () => buttons[0]!.props.onClick());
        expect(onKeepOpen).toHaveBeenCalledExactlyOnceWith(file);
      }
      expect(onSelect).not.toHaveBeenCalled();
      expect(onCloseSurface).not.toHaveBeenCalled();
      await act(async () => renderer.unmount());
    },
  );
  it("shows actual recent identities separately without hiding open views", () => {
    const second = {
      ...chat,
      tabKey: "chat:two",
      title: "Agent Two",
    } as ProjectSurface;
    const markup = renderToStaticMarkup(
      picker({
        surfaces: [chat, second],
        recentTabIds: ["missing", "chat:two", "chat:two", "chat:one"],
      }),
    );
    expect(markup.indexOf('aria-label="Reopen recent Agent Two"')).toBeLessThan(
      markup.indexOf('aria-label="Reopen recent Agent One"'),
    );
    expect(markup.match(/aria-label="Reopen recent Agent Two"/g)).toHaveLength(
      1,
    );
    expect(markup).toContain('aria-label="Open Agent One"');
    expect(markup).toContain('aria-label="Open Agent Two"');
    expect(renderToStaticMarkup(picker())).not.toContain(
      'aria-label="Recently used views"',
    );
  });
  it("shows one flat list of open views before direct creation actions", () => {
    const markup = renderToStaticMarkup(picker());

    expect(markup).toContain("Project tabs");
    expect(markup).toContain("Open views");
    expect(markup).toContain("Add a view");
    expect(markup).toContain('aria-label="Open Agent One"');
    expect(markup).toContain('aria-label="Archive Agent One"');
    expect(markup).toContain('aria-label="Close Agent One view"');
    expect(markup).not.toContain(
      'aria-label="Remove Agent One from project tabs"',
    );
    expect(markup.match(/>Overview</g)).toHaveLength(1);
    expect(markup).not.toContain("Automatic");
  });

  it("selects, closes, and archives agents through separate tap targets", async () => {
    const onArchiveSurface = vi.fn();
    const onCloseSurface = vi.fn();
    const onOpenChange = vi.fn();
    const onSelect = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        picker({
          onArchiveSurface,
          onCloseSurface,
          onOpenChange,
          onSelect,
          recentTabIds: [chat.tabKey],
        }),
      );
    });

    renderer.root
      .findByProps({ "aria-label": "Open Agent One" })
      .props.onClick();
    expect(onSelect).toHaveBeenCalledWith("chat:one");
    expect(onOpenChange).toHaveBeenCalledWith(false);

    onSelect.mockClear();
    renderer.root
      .findByProps({ "aria-label": "Reopen recent Agent One" })
      .props.onClick();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(chat.tabKey);
    expect(onCloseSurface).not.toHaveBeenCalled();
    expect(onArchiveSurface).not.toHaveBeenCalled();

    renderer.root
      .findByProps({ "aria-label": "Close Agent One view" })
      .props.onClick();
    expect(onCloseSurface).toHaveBeenCalledExactlyOnceWith(chat);
    expect(onArchiveSurface).not.toHaveBeenCalled();

    renderer.root
      .findByProps({ "aria-label": "Archive Agent One" })
      .props.onClick();
    expect(onArchiveSurface).toHaveBeenCalledWith(chat);
    expect(onCloseSurface).toHaveBeenCalledTimes(1);

    await act(async () => renderer.unmount());
  });

  it("exposes distinct file titles in the same worktree", () => {
    const files = ["first.ts", "second.ts"].map(
      (title) =>
        ({
          kind: "explorer",
          title,
          tabKey: `file:${title}`,
          entity: { selectedPath: title, worktreeId: "shared-worktree" },
        }) as ProjectSurface,
    );
    const markup = renderToStaticMarkup(picker({ surfaces: files }));
    expect(markup).toContain('aria-label="Open first.ts"');
    expect(markup).toContain('aria-label="Open second.ts"');
    expect(markup).not.toContain('aria-label="Open Explorer"');
  });

  it("creates a view without exposing desktop placement nesting", async () => {
    const onCreate = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(picker({ onCreate }));
    });

    const agentButton = renderer.root
      .findAllByType("button")
      .find(
        (button) => button.props.children?.[1]?.props?.children === "Agent",
      );
    expect(agentButton).toBeDefined();
    agentButton!.props.onClick();
    expect(onCreate).toHaveBeenCalledWith("chat");

    await act(async () => renderer.unmount());
  });
});
