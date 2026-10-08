// @vitest-environment jsdom
import type { ExplorerSummary } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getExplorerFile } from "@/lib/api";
const graphView = vi.hoisted(() => ({
  onActivateFile: null as ((path: string) => void) | null,
}));
const fileBrowser = vi.hoisted(() => ({
  onShowInGraph: null as ((path: string | null) => void) | null,
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
let root: Root;
let client: QueryClient;
let container: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  client?.clear();
  container?.remove();
  vi.clearAllMocks();
});
async function renderPreview(
  markdown: string,
  onOpenFile = vi.fn(),
  onOpenGraphFile?: (explorer: ExplorerSummary, path: string) => void,
) {
  const path = "notes/source ünicode.md";
  vi.mocked(getExplorerFile).mockResolvedValue({
    path,
    content: markdown,
    markdown: true,
    version: "one",
  } as Awaited<ReturnType<typeof getExplorerFile>>);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const explorer = {
    activeWorkerId: "worker-one",
    fileMode: "preview",
    id: "explorer-one",
    projectId: "project-one",
    selectedPath: null,
    worktreeId: "worktree-one",
  } as ExplorerSummary;
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ExplorerView
          appearance="dark"
          explorer={explorer}
          onOpenFile={onOpenFile}
          onOpenGraphFile={onOpenGraphFile}
          repositoryGraphAvailable={false}
          transientFile={{ path, close: vi.fn() }}
        />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  return { explorer, onOpenFile };
}
async function clickLink(name: string) {
  const link = [...container.querySelectorAll("a")].find(
    (a) => a.textContent === name,
  )!;
  expect(link).toBeDefined();
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () => {
    link.dispatchEvent(event);
  });
  return event;
}
describe("Explorer Markdown navigation", () => {
  it("opens relative and encoded sibling links in the same authorized Explorer flow", async () => {
    const { explorer, onOpenFile } = await renderPreview(
      "[root](../README.md)\n\n[unicode](space%20%C3%BCnicode.md)",
    );
    expect((await clickLink("root")).defaultPrevented).toBe(true);
    expect(onOpenFile).toHaveBeenLastCalledWith(
      explorer,
      expect.objectContaining({ path: "README.md", kind: "file" }),
    );
    await clickLink("unicode");
    expect(onOpenFile).toHaveBeenLastCalledWith(
      explorer,
      expect.objectContaining({ path: "notes/space ünicode.md" }),
    );
  });
  it("routes transient preview links through the existing project file navigation", async () => {
    const route = vi.fn();
    const { explorer, onOpenFile } = await renderPreview(
      "[root](../README.md)",
      vi.fn(),
      route,
    );
    await clickLink("root");
    expect(route).toHaveBeenCalledWith(explorer, "README.md");
    expect(onOpenFile).not.toHaveBeenCalled();
  });
  it("rejects traversal without opening a file or navigating the client", async () => {
    const { onOpenFile } = await renderPreview("[outside](../../outside.md)");
    expect((await clickLink("outside")).defaultPrevented).toBe(true);
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(container.textContent).toContain("outside this project");
  });
  it("uses the actual file operation for missing paths and reports its error", async () => {
    const onOpenFile = vi
      .fn()
      .mockRejectedValue(new Error("QA file does not exist"));
    await renderPreview("[missing](missing.md)", onOpenFile);
    await clickLink("missing");
    expect(onOpenFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ path: "notes/missing.md" }),
    );
    expect(container.textContent).toContain("QA file does not exist");
  });
  it("scrolls a local heading anchor without opening another surface", async () => {
    const { onOpenFile } = await renderPreview(
      "[anchor](#target-heading)\n\n## Target heading",
    );
    const heading = container.querySelector("h2")!;
    const scroll = vi.fn();
    heading.scrollIntoView = scroll;
    expect((await clickLink("anchor")).defaultPrevented).toBe(true);
    expect(scroll).toHaveBeenCalledOnce();
    expect(onOpenFile).not.toHaveBeenCalled();
  });
  it("preserves ordinary external HTTP link behavior", async () => {
    const { onOpenFile } = await renderPreview(
      "[external](https://example.com/docs)",
    );
    const link = container.querySelector("a")!;
    expect(link.href).toBe("https://example.com/docs");
    expect(link.target).toBe("_blank");
    expect((await clickLink("external")).defaultPrevented).toBe(false);
    expect(onOpenFile).not.toHaveBeenCalled();
  });
});
