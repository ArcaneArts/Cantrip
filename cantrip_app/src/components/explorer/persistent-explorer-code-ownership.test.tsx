import type { ExplorerSummary } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, useEffect } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const connections = vi.hoisted(() => ({
  created: [] as string[],
  released: [] as string[],
}));

vi.mock("@/components/chat/markdown", () => ({
  Markdown: () => createElement("div"),
}));
vi.mock("@/components/explorer/explorer-code-editor", () => ({
  ExplorerCodeEditor: ({
    active,
    explorerId,
    path,
  }: {
    active: boolean;
    explorerId: string;
    path: string | null;
  }) => {
    useEffect(() => {
      connections.created.push(explorerId);
      return () => {
        connections.released.push(explorerId);
      };
    }, [explorerId]);
    return createElement("div", {
      "data-active": active,
      "data-code-owner": explorerId,
      "data-path": path,
    });
  },
}));
vi.mock("@/components/explorer/explorer-file-browser", () => ({
  ExplorerFileBrowser: () => createElement("div"),
}));
vi.mock("@/components/explorer/explorer-image-viewport", () => ({
  ExplorerImageViewport: () => createElement("div"),
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
  GitRepositoryGraphView: () => createElement("div"),
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

import { PersistentExplorerViews } from "./persistent-explorer-views";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function explorer(id: string, selectedPath: string | null): ExplorerSummary {
  return {
    activeWorkerId: "worker-one",
    fileMode: "edit",
    id,
    projectId: "project-one",
    selectedPath,
    title: id,
    worktreeId: "worktree-one",
  } as ExplorerSummary;
}

describe("Persistent Explorer Code ownership", () => {
  beforeEach(() => {
    connections.created.length = 0;
    connections.released.length = 0;
  });

  it("connects restored tabs once, preserves them across switches, and releases only a closed tab", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const first = explorer("first-explorer", "src/first.ts");
    const second = explorer("second-explorer", "src/second.ts");
    const preview = explorer("preview-explorer", null);
    const render = (
      activeExplorer: ExplorerSummary,
      openExplorers: ExplorerSummary[],
    ) =>
      createElement(
        QueryClientProvider,
        { client },
        createElement(PersistentExplorerViews, {
          activeExplorer,
          appearance: "dark",
          gitStatuses: {},
          openExplorers,
          prewarmExplorer: preview,
          repositoryGraphAvailable: false,
        }),
      );
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(render(first, [first, second]));
    });
    expect(connections.created).toEqual([first.id, second.id, preview.id]);
    expect(connections.released).toEqual([]);

    await act(async () => renderer.update(render(second, [first, second])));
    expect(connections.created).toEqual([first.id, second.id, preview.id]);
    expect(connections.released).toEqual([]);
    expect(
      renderer.root.findByProps({ "data-code-owner": first.id }).props[
        "data-active"
      ],
    ).toBe(false);
    expect(
      renderer.root.findByProps({ "data-code-owner": second.id }).props[
        "data-active"
      ],
    ).toBe(true);

    await act(async () => renderer.update(render(second, [second])));
    expect(connections.created).toEqual([first.id, second.id, preview.id]);
    expect(connections.released).toEqual([first.id]);

    await act(async () => renderer.unmount());
    client.clear();
  });
});
