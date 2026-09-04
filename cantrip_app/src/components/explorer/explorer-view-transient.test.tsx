import type { ExplorerSummary } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const graphView = vi.hoisted(() => ({
  onActivateFile: null as ((path: string) => void) | null,
}));
const fileBrowser = vi.hoisted(() => ({
  onShowInGraph: null as ((path: string | null) => void) | null,
}));

vi.mock("@/components/chat/markdown", () => ({
  Markdown: () => createElement("div"),
}));
vi.mock("@/components/explorer/explorer-file-browser", () => ({
  ExplorerFileBrowser: ({
    onShowInGraph,
  }: {
    onShowInGraph?: (path: string | null) => void;
  }) => {
    fileBrowser.onShowInGraph = onShowInGraph ?? null;
    return createElement("div");
  },
}));
vi.mock("@/components/explorer/explorer-image-viewport", () => ({
  ExplorerImageViewport: () => createElement("div"),
}));
vi.mock("@/components/explorer/retained-explorer-code-editor", () => ({
  RetainedExplorerCodeEditor: ({
    path,
    visible,
  }: {
    path: string | null;
    visible: boolean;
  }) =>
    createElement("div", {
      "data-path": path,
      "data-retained-code-editor": true,
      "data-visible": visible,
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
vi.mock("@/components/explorer/use-retained-inline-workbench", () => ({
  useRetainedInlineWorkbench: () => true,
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
  getExplorerFile: vi.fn(),
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

import { ExplorerView } from "./explorer-view";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("ExplorerView transient selection", () => {
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

    expect(
      renderer.root.findByProps({ "data-retained-code-editor": true }).props[
        "data-path"
      ],
    ).toBe("src/requested.ts");
    expect(
      renderer.root.findByProps({ "data-retained-code-editor": true }).props[
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

    expect(
      renderer.root.findByProps({ "data-retained-code-editor": true }).props[
        "data-path"
      ],
    ).toBe("src/requested.ts");
    expect(
      renderer.root.findByProps({ "data-retained-code-editor": true }).props[
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

    const editor = renderer.root.findByProps({
      "data-retained-code-editor": true,
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
