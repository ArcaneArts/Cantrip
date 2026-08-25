import type { ExplorerSummary } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/chat/markdown", () => ({
  Markdown: () => createElement("div"),
}));
vi.mock("@/components/explorer/explorer-file-browser", () => ({
  ExplorerFileBrowser: () => createElement("div"),
}));
vi.mock("@/components/explorer/explorer-image-viewport", () => ({
  ExplorerImageViewport: () => createElement("div"),
}));
vi.mock("@/components/explorer/retained-explorer-code-editor", () => ({
  RetainedExplorerCodeEditor: ({ activePath }: { activePath: string | null }) =>
    createElement("div", {
      "data-active-path": activePath,
      "data-retained-code-editor": true,
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

import { ExplorerView } from "./explorer-view";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("ExplorerView transient selection", () => {
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
        "data-active-path"
      ],
    ).toBe("src/requested.ts");

    await act(async () => renderer.unmount());
    client.clear();
  });
});
