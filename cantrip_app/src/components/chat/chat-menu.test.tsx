import type { ProjectWorktreeSummary } from "@cantrip/protocol";
import type { ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const primitives = vi.hoisted(() => {
  const Container = ({ children }: { children: ReactNode }) => children;
  const Item = ({ children, ...props }: { children: ReactNode }) => (
    <button data-menu-item {...props}>
      {children}
    </button>
  );
  return {
    Content: Container,
    Item,
    Portal: Container,
    Root: Container,
    Separator: () => <hr />,
    Sub: Container,
    SubContent: Container,
    SubTrigger: Container,
    Trigger: Container,
  };
});
vi.mock("@radix-ui/react-context-menu", () => primitives);
vi.mock("@radix-ui/react-dropdown-menu", () => primitives);

import {
  ChatContextMenu,
  ChatDropdownMenu,
  type ChatWorktreeActions,
} from "./chat-menu";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function textContent(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textContent(child)))
    .join("");
}

describe("shared chat menus", () => {
  it.each(["agent-managed", "pinned"] as const)(
    "shares actions, disabled worktrees, and callbacks in %s mode",
    async (mode) => {
      const worktree: ChatWorktreeActions = {
        currentWorktreeId: "primary",
        mode,
        onCreate: vi.fn(),
        onOpenExplorer: vi.fn(),
        onOpenHistory: vi.fn(),
        onOpenTerminal: vi.fn(),
        onSelect: vi.fn(),
        onSetMode: vi.fn(),
        worktrees: [
          {
            id: "primary",
            name: "Primary",
            isPrimary: true,
            lifecycleState: "ready",
          },
          {
            id: "preparing",
            name: "Preparing",
            isPrimary: false,
            lifecycleState: "creating",
          },
        ] as ProjectWorktreeSummary[],
      };
      const actions = {
        deleteLabel: "Archive",
        deleteDisabled: true,
        onClose: vi.fn(),
        onDelete: vi.fn(),
        onDuplicate: vi.fn(),
        onRename: vi.fn(),
        worktree,
      };
      const results = [];
      for (const kind of ["context", "dropdown"] as const) {
        let renderer!: TestRenderer.ReactTestRenderer;
        await act(async () => {
          renderer = TestRenderer.create(
            kind === "context" ? (
              <ChatContextMenu actions={actions}>
                <button>Agent</button>
              </ChatContextMenu>
            ) : (
              <ChatDropdownMenu actions={actions} title="Agent" />
            ),
          );
        });
        const items = renderer.root.findAllByProps({ "data-menu-item": true });
        results.push(
          items.map((item) => ({
            label: textContent(item).trim(),
            disabled: Boolean(item.props.disabled),
          })),
        );
        const select = async (label: string) =>
          act(async () =>
            items
              .find((item) => textContent(item).trim() === label)!
              .props.onSelect(),
          );
        expect(
          items.find((item) => textContent(item).trim() === "Preparing")!.props
            .disabled,
        ).toBe(true);
        expect(
          items.find(
            (item) => textContent(item).trim() === "Stop agent before archive",
          )!.props.disabled,
        ).toBe(true);
        await select("Rename");
        await select("Duplicate");
        await select("Primary✓");
        await select(
          mode === "pinned" ? "Return to Agent managed" : "Pin to current",
        );
        await select("Open Terminal here");
        await act(async () => renderer.unmount());
      }
      expect(results[0]).toEqual(results[1]);
      expect(actions.onRename).toHaveBeenCalledTimes(2);
      expect(actions.onDuplicate).toHaveBeenCalledTimes(2);
      expect(worktree.onSelect).toHaveBeenNthCalledWith(1, "primary");
      expect(worktree.onSelect).toHaveBeenNthCalledWith(2, "primary");
      expect(worktree.onSetMode).toHaveBeenNthCalledWith(
        1,
        mode === "pinned" ? "agent-managed" : "pinned",
      );
      expect(worktree.onSetMode).toHaveBeenNthCalledWith(
        2,
        mode === "pinned" ? "agent-managed" : "pinned",
      );
      expect(worktree.onOpenTerminal).toHaveBeenCalledTimes(2);
      expect(actions.onDelete).not.toHaveBeenCalled();
    },
  );
});
