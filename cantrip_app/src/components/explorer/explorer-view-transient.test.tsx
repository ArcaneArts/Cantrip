// @vitest-environment jsdom
import type { ExplorerEntry, ExplorerSummary } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const graphView = vi.hoisted(() => ({
  onActivateFile: null as ((path: string) => void) | null,
}));
const fileBrowser = vi.hoisted(() => ({
  onShowInGraph: null as ((path: string | null) => void) | null,
  onOpenFile: null as ((entry: ExplorerEntry) => void) | null,
}));

vi.mock("@/components/chat/markdown", () => ({
  Markdown: () => createElement("div"),
}));
vi.mock("@/components/explorer/explorer-file-browser", () => ({
  ExplorerFileBrowser: ({
    onShowInGraph,
    onOpenFile,
  }: {
    onShowInGraph?: (path: string | null) => void;
    onOpenFile(entry: ExplorerEntry): void;
  }) => {
    fileBrowser.onShowInGraph = onShowInGraph ?? null;
    fileBrowser.onOpenFile = onOpenFile;
    return createElement("div");
  },
}));
vi.mock("@/components/explorer/explorer-image-viewport", () => ({
  ExplorerImageViewport: () => createElement("div"),
}));

vi.mock("@/components/editor/native-code-editor", () => ({
  NativeCodeEditor: ({ path, active }: { path: string; active: boolean }) =>
    createElement("div", {
      "data-native-code-editor": true,
      "data-path": path,
      "data-visible": active,
    }),
}));
vi.mock("@/components/explorer/use-explorer-worker-encryption", () => ({
  useExplorerWorkerEncryption: () => ({
    bindingKey: "binding-one",
    error: null,
    ready: true,
    retry: vi.fn(),
  }),
}));

vi.mock("@/components/git/git-graph", () => ({
  GitRepositoryGraphView: ({
    onActivateFile,
  }: {
    onActivateFile?: (path: string) => void;
  }) => {
    graphView.onActivateFile = onActivateFile ?? null;
    return createElement("div", { "data-repository-graph": true });
  },
}));
vi.mock("@/lib/api", () => ({
  getExplorerFile: vi.fn(async (_id: string, path: string) => ({
    path,
    content: `content for ${path}`,
    version: "one",
    markdown: false,
  })),
  loadExplorerMedia: vi.fn(),
  saveExplorerFile: vi.fn(),
  updateExplorerViewState: vi.fn(),
}));
vi.mock("@/lib/client-log-relay", () => ({
  clientLogger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { ExplorerView, type ExplorerHeaderState } from "./explorer-view";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("ExplorerView transient selection", () => {
  it.each(["dismiss", "refresh", "retry", "scope"])(
    "recovers a failed file action without latching a worker error (%s)",
    async (recovery) => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const explorer = {
        activeWorkerId: "worker-one",
        fileMode: "preview",
        id: "explorer-one",
        projectId: "project-one",
        selectedPath: null,
        worktreeId: "worktree-one",
      } as ExplorerSummary;
      const onOpenFile = vi
        .fn()
        .mockRejectedValueOnce(
          new Error(
            "Workspace transfer timed out waiting for destination state restoration.",
          ),
        )
        .mockResolvedValue(undefined);
      const entry = {
        kind: "file",
        path: "README.md",
        viewable: true,
      } as ExplorerEntry;
      let renderer!: TestRenderer.ReactTestRenderer;
      let header: ExplorerHeaderState | null = null;
      const captureHeader = (value: ExplorerHeaderState | null) => {
        header = value;
      };
      const view = (summary = explorer) =>
        createElement(
          QueryClientProvider,
          { client },
          createElement(ExplorerView, {
            appearance: "dark",
            explorer: summary,
            onHeaderChange: captureHeader,
            onOpenFile,
            repositoryGraphAvailable: false,
          }),
        );
      try {
        await act(async () => {
          renderer = TestRenderer.create(view());
        });
        await act(async () => {
          fileBrowser.onOpenFile!(entry);
        });
        const alerts = () => renderer.root.findAllByProps({ role: "alert" });
        expect(alerts()).toHaveLength(1);
        expect(
          alerts()[0]!.findByType("span").props.children.join(""),
        ).toContain("Could not open file");
        if (recovery === "dismiss") {
          const dismiss = renderer.root
            .findAllByType("button")
            .find((button) => button.props.children === "Dismiss")!;
          await act(async () => dismiss.props.onClick());
        } else if (recovery === "refresh") {
          await act(async () => header!.refresh());
        } else if (recovery === "retry") {
          await act(async () => {
            fileBrowser.onOpenFile!(entry);
          });
        } else {
          await act(async () =>
            renderer.update(view({ ...explorer, worktreeId: "other-tree" })),
          );
        }
        expect(alerts()).toHaveLength(0);
      } finally {
        await act(async () => renderer?.unmount());
        client.clear();
      }
    },
  );

  it("clears a read error on that query's recovery and ignores an older action failure", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const explorer = {
      activeWorkerId: "worker-one",
      fileMode: "preview",
      id: "explorer-one",
      projectId: "project-one",
      selectedPath: null,
      worktreeId: "worktree-one",
    } as ExplorerSummary;
    const queryKey = [
      "explorer-directory",
      "project-one",
      "worktree-one",
      "explorer-one",
      "",
    ];
    const failure = new Error("Worker request timed out");
    let rejectOld!: (error: Error) => void;
    const onOpenFile = vi
      .fn()
      .mockImplementationOnce(() =>
        client.fetchQuery({ queryKey, queryFn: () => Promise.reject(failure) }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectOld = reject;
          }),
      )
      .mockResolvedValue(undefined);
    const entry = {
      kind: "file",
      path: "README.md",
      viewable: true,
    } as ExplorerEntry;
    let renderer!: TestRenderer.ReactTestRenderer;
    try {
      await act(async () => {
        renderer = TestRenderer.create(
          createElement(
            QueryClientProvider,
            { client },
            createElement(ExplorerView, {
              appearance: "dark",
              explorer,
              onOpenFile,
              repositoryGraphAvailable: false,
            }),
          ),
        );
      });
      const alerts = () => renderer.root.findAllByProps({ role: "alert" });
      await act(async () => {
        fileBrowser.onOpenFile!(entry);
      });
      expect(alerts()).toHaveLength(1);
      await act(async () => {
        client.setQueryData(["unrelated-worker-read"], "ok");
      });
      expect(alerts()).toHaveLength(1);
      await act(async () => {
        await client.fetchQuery({ queryKey, queryFn: async () => "recovered" });
      });
      expect(alerts()).toHaveLength(0);
      await act(async () => {
        fileBrowser.onOpenFile!(entry);
      });
      await act(async () => {
        fileBrowser.onOpenFile!(entry);
      });
      await act(async () => {
        rejectOld(new Error("Late failure from an older action"));
      });
      expect(alerts()).toHaveLength(0);
    } finally {
      await act(async () => renderer?.unmount());
      client.clear();
    }
  });

  it.each([null, "entry"])(
    "keeps the initial graph request for root %s",
    async (rootPath) => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const explorer = {
        activeWorkerId: "worker-one",
        fileMode: "preview",
        id: "explorer-one",
        projectId: "project-one",
        selectedPath: null,
        worktreeId: "worktree-one",
      } as ExplorerSummary;
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(
          createElement(
            QueryClientProvider,
            { client },
            createElement(ExplorerView, {
              active: true,
              appearance: "dark",
              explorer,
              graphRequest: {
                explorerId: explorer.id,
                requestId: "graph-one",
                rootPath,
              },
              repositoryGraphAvailable: true,
            }),
          ),
        );
      });
      expect(
        renderer.root.findAllByProps({ "data-repository-graph": true }),
      ).toHaveLength(1);
      await act(async () => renderer.unmount());
      client.clear();
    },
  );

  it("routes graph files to the workspace editor instead of the Explorer file callback", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const explorer = {
      activeWorkerId: "worker-one",
      fileMode: "preview",
      id: "explorer-one",
      projectId: "project-one",
      selectedPath: null,
      worktreeId: "worktree-one",
    } as ExplorerSummary;
    const onOpenFile = vi.fn();
    const onOpenGraphFile = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        createElement(
          QueryClientProvider,
          { client },
          createElement(ExplorerView, {
            active: true,
            appearance: "dark",
            explorer,
            onOpenFile,
            onOpenGraphFile,
            repositoryGraphAvailable: true,
          }),
        ),
      );
    });

    act(() => fileBrowser.onShowInGraph?.(null));
    act(() => graphView.onActivateFile?.("src/app.ts"));

    expect(onOpenGraphFile).toHaveBeenCalledWith(explorer, "src/app.ts");
    expect(onOpenFile).not.toHaveBeenCalled();

    await act(async () => renderer.unmount());
    client.clear();
  });

  it("opens only the transient Code path on its first active render", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const explorer = {
      activeWorkerId: "worker-one",
      fileMode: "edit",
      id: "explorer-one",
      projectId: "project-one",
      selectedPath: "src/stale.ts",
      worktreeId: "worktree-one",
    } as ExplorerSummary;
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        createElement(
          QueryClientProvider,
          { client },
          createElement(ExplorerView, {
            active: true,
            appearance: "dark",
            explorer,
            gitStatus: undefined,
            repositoryGraphAvailable: false,
            transientFile: {
              close: vi.fn(),
              path: "src/requested.ts",
            },
          }),
        ),
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(
      renderer.root.findByProps({ "data-native-code-editor": true }).props[
        "data-path"
      ],
    ).toBe("src/requested.ts");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(
      renderer.root.findByProps({ "data-native-code-editor": true }).props[
        "data-visible"
      ],
    ).toBe(true);

    await act(async () => renderer.unmount());
    client.clear();
  });

  it("keeps the transient Code path when the same Explorer is pinned", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const preview = {
      activeWorkerId: "worker-one",
      fileMode: "preview",
      id: "explorer-one",
      projectId: "project-one",
      selectedPath: null,
      worktreeId: "worktree-one",
    } as ExplorerSummary;
    const pinned = {
      ...preview,
      fileMode: "edit",
      selectedPath: "src/requested.ts",
    } as ExplorerSummary;
    const render = (
      explorer: ExplorerSummary,
      transientFile?: { close: () => void; path: string },
    ) =>
      createElement(
        QueryClientProvider,
        { client },
        createElement(ExplorerView, {
          active: true,
          appearance: "dark",
          explorer,
          gitStatus: undefined,
          repositoryGraphAvailable: false,
          transientFile,
        }),
      );
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        render(preview, {
          close: vi.fn(),
          path: "src/requested.ts",
        }),
      );
    });
    await act(async () => renderer.update(render(pinned)));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(
      renderer.root.findByProps({ "data-native-code-editor": true }).props[
        "data-path"
      ],
    ).toBe("src/requested.ts");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(
      renderer.root.findByProps({ "data-native-code-editor": true }).props[
        "data-visible"
      ],
    ).toBe(true);

    await act(async () => renderer.unmount());
    client.clear();
  });

  it("keeps an open pinned Code path mounted while its tab is inactive", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const explorer = {
      activeWorkerId: "worker-one",
      fileMode: "edit",
      id: "explorer-one",
      projectId: "project-one",
      selectedPath: "src/pinned.ts",
      worktreeId: "worktree-one",
    } as ExplorerSummary;
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        createElement(
          QueryClientProvider,
          { client },
          createElement(ExplorerView, {
            active: false,
            appearance: "dark",
            explorer,
            gitStatus: undefined,
            keepInlineCodeWarm: true,
            repositoryGraphAvailable: false,
          }),
        ),
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const editor = renderer.root.findByProps({
      "data-native-code-editor": true,
    });
    const surface = renderer.root.findByProps({
      "data-slot": "explorer-view",
    });
    expect(editor.props["data-path"]).toBe("src/pinned.ts");
    expect(editor.props["data-visible"]).toBe(false);
    expect(surface.props["aria-hidden"]).toBe(true);
    expect(surface.props.inert).toBe(true);
    expect(surface.props.className).toContain("invisible");
    expect(surface.props.className.split(/\s+/)).not.toContain("hidden");
    expect(surface.props.className.split(/\s+/)).not.toContain("bg-background");

    await act(async () => renderer.unmount());
    client.clear();
  });
});
