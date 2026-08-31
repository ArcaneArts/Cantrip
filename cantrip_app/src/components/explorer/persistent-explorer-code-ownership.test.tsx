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

function explorer(id: string, selectedPath: string): ExplorerSummary {
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

function view(
  client: QueryClient,
  activeExplorer: ExplorerSummary,
  openExplorers: ExplorerSummary[],
  prewarmExplorer: ExplorerSummary | null = null,
) {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(PersistentExplorerViews, {
      activeExplorer,
      appearance: "dark",
      gitStatuses: {},
      openExplorers,
      prewarmExplorer,
      repositoryGraphAvailable: false,
    }),
  );
}

function createClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

describe("Persistent Explorer Code ownership", () => {
  beforeEach(() => {
    connections.created.length = 0;
    connections.released.length = 0;
  });

  it("keeps inactive open and prewarm Explorers dormant before activation", async () => {
    const queryClient = createClient();
    const first = explorer("first-explorer", "src/first.ts");
    const second = explorer("second-explorer", "src/second.ts");
    const prewarm = explorer("prewarm-explorer", "src/prewarm.ts");
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        view(queryClient, first, [first, second], prewarm),
      );
    });

    expect(connections.created).toEqual([first.id]);
    expect(connections.released).toEqual([]);
    expect(
      renderer.root.findAllByProps({ "data-code-owner": second.id }),
    ).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ "data-code-owner": prewarm.id }),
    ).toHaveLength(0);

    await act(async () => renderer.unmount());
    queryClient.clear();
  });

  it("creates an inactive open Explorer exactly once when first activated", async () => {
    const queryClient = createClient();
    const first = explorer("first-explorer", "src/first.ts");
    const second = explorer("second-explorer", "src/second.ts");
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(view(queryClient, first, [first, second]));
    });
    await act(async () => {
      renderer.update(view(queryClient, second, [first, second]));
    });
    await act(async () => {
      renderer.update(view(queryClient, second, [first, second]));
    });

    expect(connections.created).toEqual([first.id, second.id]);
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

    await act(async () => renderer.unmount());
    queryClient.clear();
  });

  it("keeps an already-created owned editor mounted while inactive", async () => {
    const queryClient = createClient();
    const first = explorer("first-explorer", "src/first.ts");
    const second = explorer("second-explorer", "src/second.ts");
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(view(queryClient, first, [first, second]));
    });
    await act(async () => {
      renderer.update(view(queryClient, second, [first, second]));
    });
    await act(async () => {
      renderer.update(view(queryClient, first, [first, second]));
    });

    expect(connections.created).toEqual([first.id, second.id]);
    expect(connections.released).toEqual([]);
    expect(
      renderer.root.findByProps({ "data-code-owner": second.id }).props[
        "data-active"
      ],
    ).toBe(false);

    await act(async () => renderer.unmount());
    queryClient.clear();
  });

  it("releases an inactive retained editor when its owning tab closes", async () => {
    const queryClient = createClient();
    const first = explorer("first-explorer", "src/first.ts");
    const second = explorer("second-explorer", "src/second.ts");
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(view(queryClient, first, [first, second]));
    });
    await act(async () => {
      renderer.update(view(queryClient, second, [first, second]));
    });
    await act(async () => {
      renderer.update(view(queryClient, second, [second]));
    });

    expect(connections.created).toEqual([first.id, second.id]);
    expect(connections.released).toEqual([first.id]);
    expect(
      renderer.root.findAllByProps({ "data-code-owner": first.id }),
    ).toHaveLength(0);
    expect(
      renderer.root.findByProps({ "data-code-owner": second.id }).props[
        "data-active"
      ],
    ).toBe(true);

    await act(async () => renderer.unmount());
    queryClient.clear();
  });
});
