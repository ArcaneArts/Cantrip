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
  it("shows one flat list of open views before direct creation actions", () => {
    const markup = renderToStaticMarkup(picker());

    expect(markup).toContain("Project tabs");
    expect(markup).toContain("Open views");
    expect(markup).toContain("Add a view");
    expect(markup).toContain('aria-label="Open Agent One"');
    expect(markup).toContain('aria-label="Remove Agent One from project tabs"');
    expect(markup.match(/>Overview</g)).toHaveLength(1);
    expect(markup).not.toContain("Automatic");
  });

  it("selects and removes surfaces through separate tap targets", async () => {
    const onCloseSurface = vi.fn();
    const onOpenChange = vi.fn();
    const onSelect = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        picker({ onCloseSurface, onOpenChange, onSelect }),
      );
    });

    renderer.root
      .findByProps({ "aria-label": "Open Agent One" })
      .props.onClick();
    expect(onSelect).toHaveBeenCalledWith("chat:one");
    expect(onOpenChange).toHaveBeenCalledWith(false);

    renderer.root
      .findByProps({ "aria-label": "Remove Agent One from project tabs" })
      .props.onClick();
    expect(onCloseSurface).toHaveBeenCalledWith(chat);

    await act(async () => renderer.unmount());
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
