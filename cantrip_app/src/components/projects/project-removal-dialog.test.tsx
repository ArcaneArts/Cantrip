import type { ProjectSummary } from "@cantrip/protocol";
import { createElement, type ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    pending: _pending,
    pendingLabel: _pendingLabel,
    ...props
  }: {
    children: ReactNode;
    pending?: boolean;
    pendingLabel?: string;
  }) => createElement("button", props, children),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? createElement("div", null, children) : null,
  DialogContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DialogDescription: ({ children }: { children: ReactNode }) =>
    createElement("p", null, children),
  DialogFooter: ({ children }: { children: ReactNode }) =>
    createElement("footer", null, children),
  DialogHeader: ({ children }: { children: ReactNode }) =>
    createElement("header", null, children),
  DialogTitle: ({ children }: { children: ReactNode }) =>
    createElement("h2", null, children),
}));

import { ProjectRemovalDialog } from "./project-removal-dialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const project = {
  id: "project-one",
  name: "Cantrip",
  originKind: "managed-folder",
  source: { displayPath: "/projects/cantrip" },
} as ProjectSummary;

describe("ProjectRemovalDialog", () => {
  it("unlinks a project without deleting its files by default", async () => {
    const onOpenChange = vi.fn();
    const onRemove = vi.fn().mockResolvedValue(undefined);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ProjectRemovalDialog
          onOpenChange={onOpenChange}
          onRemove={onRemove}
          project={project}
        />,
      );
    });

    await act(async () =>
      renderer.root.findAllByType("button").at(1)!.props.onClick(),
    );

    expect(onRemove).toHaveBeenCalledWith(project.id, false);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await act(async () => renderer.unmount());
  });

  it("preserves the second confirmation before deleting managed files", async () => {
    const onOpenChange = vi.fn();
    const onRemove = vi.fn().mockResolvedValue(undefined);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ProjectRemovalDialog
          onOpenChange={onOpenChange}
          onRemove={onRemove}
          project={project}
        />,
      );
    });

    act(() =>
      renderer.root
        .findByType("input")
        .props.onChange({ target: { checked: true } }),
    );
    act(() => renderer.root.findAllByType("button").at(1)!.props.onClick());
    expect(onRemove).not.toHaveBeenCalled();

    await act(async () =>
      renderer.root.findAllByType("button").at(1)!.props.onClick(),
    );

    expect(onRemove).toHaveBeenCalledWith(project.id, true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await act(async () => renderer.unmount());
  });
});
