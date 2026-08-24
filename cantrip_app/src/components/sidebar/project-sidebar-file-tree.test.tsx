import type { ExplorerEntry, ExplorerSummary } from "@cantrip/protocol";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => {
  const entry = {
    kind: "file",
    markdown: false,
    modifiedAt: "2026-08-23T12:00:00.000Z",
    name: "example.ts",
    path: "example.ts",
    size: 10,
    symbolicLink: false,
    viewable: true,
  } satisfies ExplorerEntry;
  const directoryEntry = {
    kind: "directory",
    markdown: false,
    modifiedAt: "2026-08-23T12:00:00.000Z",
    name: "src",
    path: "src",
    size: null,
    symbolicLink: false,
    viewable: false,
  } satisfies ExplorerEntry;
  return {
    directory: vi.fn(),
    directoryEntry,
    entry,
    entriesByPath: new Map<string, ExplorerEntry[]>(),
    gate: {
      bindingKey: "binding-a" as string | null,
      error: null as string | null,
      ready: true,
      retry: vi.fn(),
    },
    workerEncryption: vi.fn(),
  };
});

vi.mock("@radix-ui/react-context-menu", async () => {
  const React = await import("react");
  const Container = React.forwardRef<unknown, { children?: React.ReactNode }>(
    ({ children }, _ref) => React.createElement(React.Fragment, null, children),
  );
  const Item = React.forwardRef<
    unknown,
    {
      children?: React.ReactNode;
      onClick?(event: { shiftKey: boolean }): void;
      onSelect?(): void;
    }
  >(({ children, onClick, onSelect }, _ref) =>
    React.createElement(
      "button",
      {
        onClick: (event: { shiftKey: boolean }) => {
          onClick?.(event);
          onSelect?.();
        },
        type: "button",
      },
      children,
    ),
  );
  return {
    Content: Container,
    Item,
    Portal: Container,
    Root: Container,
    Separator: () => null,
    Trigger: Container,
  };
});
vi.mock("@/components/ui/confirm-dialog", async () => {
  const React = await import("react");
  return {
    ConfirmDialog: ({
      confirmLabel,
      onConfirm,
      open,
    }: {
      confirmLabel: React.ReactNode;
      onConfirm(): void;
      open: boolean;
    }) =>
      open
        ? React.createElement(
            "button",
            {
              "aria-label": "Confirm file mutation",
              onClick: onConfirm,
              type: "button",
            },
            confirmLabel,
          )
        : null,
  };
});
vi.mock("@/components/explorer/use-explorer-directory", () => ({
  useExplorerDirectory: (input: { enabled: boolean; path: string }) => {
    runtime.directory(input);
    const entries = input.enabled
      ? (runtime.entriesByPath.get(input.path) ?? [])
      : [];
    return {
      commitByPath: new Map(),
      commits: { data: undefined, isError: false, isLoading: false },
      directory: {
        data: input.enabled ? { entries } : undefined,
        isError: false,
        isLoading: false,
      },
      entries,
    };
  },
}));
vi.mock(
  "@/components/explorer/use-explorer-worker-encryption",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/explorer/use-explorer-worker-encryption")
      >();
    return {
      ...actual,
      useExplorerWorkerEncryption: (
        explorer: ExplorerSummary | null,
        enabled = true,
      ) => {
        runtime.workerEncryption(explorer, enabled);
        return enabled
          ? runtime.gate
          : { ...runtime.gate, error: null, ready: false };
      },
    };
  },
);

import { ProjectSidebarFileTree } from "./project-sidebar-file-tree";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const explorer = {
  activeWorkerId: "worker-a",
  id: "explorer-a",
  projectId: "project-a",
  worktreeId: "worktree-a",
} as ExplorerSummary;

function tree(
  overrides: Partial<ComponentProps<typeof ProjectSidebarFileTree>> = {},
) {
  return createElement(ProjectSidebarFileTree, {
    activePath: null,
    explorer,
    loading: false,
    onDelete: async () => undefined,
    onPin: () => undefined,
    onPreview: () => undefined,
    onRename: async () => undefined,
    ...overrides,
  });
}

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

function buttonNamed(
  renderer: TestRenderer.ReactTestRenderer,
  name: string,
): TestRenderer.ReactTestInstance {
  const button = renderer.root
    .findAllByType("button")
    .find((candidate) => textContent(candidate.props.children).includes(name));
  if (!button) throw new Error(`Button not found: ${name}`);
  return button;
}

describe("project sidebar file tree encryption gate", () => {
  beforeEach(() => {
    runtime.directory.mockClear();
    runtime.entriesByPath.clear();
    runtime.entriesByPath.set("", [runtime.entry]);
    runtime.workerEncryption.mockClear();
    runtime.gate.bindingKey = "binding-a";
    runtime.gate.error = null;
    runtime.gate.ready = true;
  });

  it("does not expose entries before the current binding is authorized", () => {
    runtime.gate.ready = false;

    const markup = renderToStaticMarkup(tree());

    expect(markup).not.toContain("example.ts");
    expect(markup).not.toContain('aria-label="Project files"');
    expect(markup).toContain("animate-spin");
  });

  it("disables authorization and protected queries while Files is collapsed", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(tree());
    });
    expect(runtime.workerEncryption).toHaveBeenLastCalledWith(explorer, true);
    expect(runtime.directory).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true }),
    );

    await act(async () => buttonNamed(renderer, "Files").props.onClick());

    expect(runtime.workerEncryption).toHaveBeenLastCalledWith(explorer, false);
    expect(runtime.directory).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );
    expect(
      renderer.root.findAllByProps({ "aria-label": "Project files" }),
    ).toHaveLength(0);
    await act(async () => renderer.unmount());
  });

  it("marks entries revealed by folder and Files expansion for global glitch effects", async () => {
    runtime.entriesByPath.set("", [runtime.directoryEntry]);
    runtime.entriesByPath.set("src", [runtime.entry]);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(tree());
    });

    const rootEntry = renderer.root.findByProps({ role: "treeitem" });
    expect(rootEntry.props["data-elite-global"]).toBe(true);
    const clickTarget = {};
    await act(async () =>
      rootEntry.props.onClick({
        currentTarget: clickTarget,
        target: clickTarget,
      }),
    );

    const expandedEntries = renderer.root.findAllByProps({ role: "treeitem" });
    expect(expandedEntries).toHaveLength(2);
    expect(
      expandedEntries.every((entry) => entry.props["data-elite-global"]),
    ).toBe(true);

    await act(async () => buttonNamed(renderer, "Files").props.onClick());
    expect(renderer.root.findAllByProps({ role: "treeitem" })).toHaveLength(0);
    await act(async () => buttonNamed(renderer, "Files").props.onClick());
    const reopenedEntries = renderer.root.findAllByProps({ role: "treeitem" });
    expect(reopenedEntries.length).toBeGreaterThan(0);
    expect(
      reopenedEntries.every((entry) => entry.props["data-elite-global"]),
    ).toBe(true);
    await act(async () => renderer.unmount());
  });

  it("rejects a stale delete confirmation after the binding changes", async () => {
    const onDelete = vi.fn(async () => undefined);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(tree({ onDelete }));
    });
    await act(async () => buttonNamed(renderer, "Delete").props.onClick());
    const staleConfirm = renderer.root.findByProps({
      "aria-label": "Confirm file mutation",
    }).props.onClick as () => void;

    runtime.gate.bindingKey = "binding-b";
    runtime.gate.ready = false;
    await act(async () => renderer.update(tree({ onDelete })));
    await act(async () => staleConfirm());

    expect(onDelete).not.toHaveBeenCalled();
    expect(
      renderer.root.findAllByProps({ "aria-label": "Confirm file mutation" }),
    ).toHaveLength(0);
    await act(async () => renderer.unmount());
  });

  it("invalidates rename authorization while its caller is awaiting work", async () => {
    let continueRename!: () => void;
    let authorizationCurrent: (() => boolean) | undefined;
    const protectedRename = vi.fn();
    const onRename = vi.fn(
      async (
        _entry: ExplorerEntry,
        _name: string,
        authorization: { isCurrent(): boolean },
      ) => {
        authorizationCurrent = authorization.isCurrent;
        await new Promise<void>((resolve) => {
          continueRename = resolve;
        });
        if (authorization.isCurrent()) protectedRename();
      },
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(tree({ onRename }));
    });
    await act(async () => buttonNamed(renderer, "Rename").props.onClick());
    const input = renderer.root.findByProps({
      "aria-label": "Rename example.ts",
    });
    await act(async () =>
      input.props.onChange({ target: { value: "renamed.ts" } }),
    );
    await act(async () =>
      input.props.onKeyDown({
        key: "Enter",
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      }),
    );
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(authorizationCurrent?.()).toBe(true);

    runtime.gate.bindingKey = "binding-b";
    runtime.gate.ready = false;
    await act(async () => renderer.update(tree({ onRename })));
    expect(authorizationCurrent?.()).toBe(false);
    await act(async () => continueRename());

    expect(protectedRename).not.toHaveBeenCalled();
    expect(
      renderer.root.findAllByProps({ "aria-label": "Rename example.ts" }),
    ).toHaveLength(0);
    await act(async () => renderer.unmount());
  });

  it("shows files in the native manager and forwards the Shift local preference", async () => {
    const onOpenNative = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        tree({ onOpenNative, revealLabel: "Finder" }),
      );
    });

    const reveal = buttonNamed(renderer, "Show in Finder");
    await act(async () => reveal.props.onClick({ shiftKey: false }));
    expect(onOpenNative).toHaveBeenLastCalledWith(runtime.entry, false);

    await act(async () => reveal.props.onClick({ shiftKey: true }));
    expect(onOpenNative).toHaveBeenLastCalledWith(runtime.entry, true);
    expect(onOpenNative).toHaveBeenCalledTimes(2);
    await act(async () => renderer.unmount());
  });
});
