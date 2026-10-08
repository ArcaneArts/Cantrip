// @vitest-environment jsdom
import type { ExplorerSummary } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { ExplorerView, type ExplorerHeaderState } from "./explorer-view";
vi.mock("@/components/explorer/explorer-file-browser", () => ({
  ExplorerFileBrowser: () => createElement("div"),
}));
vi.mock("@/components/explorer/retained-explorer-code-editor", () => ({
  RetainedExplorerCodeEditor: ({
    path,
    visible,
  }: {
    path: string | null;
    visible: boolean;
  }) =>
    createElement(
      "div",
      { "data-code-path": path, "data-code-visible": visible },
      visible ? "Code endpoint failed (fixture)" : null,
    ),
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
  clientLogger: { info: vi.fn(), warn: vi.fn() },
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let client: QueryClient;
let container: HTMLDivElement;
let header: ExplorerHeaderState | null;
afterEach(async () => {
  await act(async () => root?.unmount());
  client?.clear();
  container?.remove();
  vi.clearAllMocks();
});
const explorer = {
  activeWorkerId: "worker-one",
  fileMode: "preview",
  id: "explorer-one",
  projectId: "project-one",
  selectedPath: null,
  worktreeId: "worktree-one",
} as ExplorerSummary;
const contents: Record<string, string> = {
  "data/settings.yaml": "enabled: true\nnested:\n  value: 42\n",
  "data/settings.json": '{"enabled":true,"nested":{"value":42}}\n',
  "README.md": "# Original document\n",
};
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
}
async function setup(
  path: string,
  initialExplorer: ExplorerSummary = explorer,
) {
  await import("./structured-file-visual");
  vi.mocked(api.getExplorerFile).mockImplementation(
    async (_id, path) =>
      ({
        path,
        content: contents[path],
        markdown: path.endsWith(".md"),
        version: "one",
      }) as Awaited<ReturnType<typeof api.getExplorerFile>>,
  );
  vi.mocked(api.updateExplorerViewState).mockImplementation(
    async (_id, state) => ({ ...explorer, ...state }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = async (
    summary: ExplorerSummary = initialExplorer,
    transientPath: string | null = path,
  ) => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ExplorerView
            appearance="dark"
            explorer={summary}
            onHeaderChange={(state) => {
              header = state;
            }}
            repositoryGraphAvailable={false}
            transientFile={
              transientPath
                ? { path: transientPath, close: vi.fn() }
                : undefined
            }
          />
        </QueryClientProvider>,
      ),
    );
    await settle();
  };
  await render();
  return render;
}
async function choose(mode: "preview" | "edit" | "visual") {
  await act(async () => header!.setFileMode(mode));
  await settle();
  expect(header!.fileMode).toBe(mode);
}
describe("Explorer transient renderer modes", () => {
  it.each(["data/settings.yaml", "data/settings.json"])(
    "renders selected Visual/View/Edit independently of Code readiness: %s",
    async (path) => {
      await setup(path);
      expect(
        container.querySelector('[data-code-visible="true"]'),
      ).not.toBeNull();
      await choose("visual");
      expect(
        container.querySelector('[aria-label="Search structured values"]'),
      ).not.toBeNull();
      expect(container.querySelector('[data-code-visible="true"]')).toBeNull();
      expect(
        container
          .querySelector('[aria-label="Edit enabled"]')
          ?.getAttribute("aria-checked"),
      ).toBe("true");
      await choose("preview");
      expect(container.querySelector("pre")?.textContent).toContain("enabled");
      expect(
        container.querySelector('[aria-label="Search structured values"]'),
      ).toBeNull();
      await choose("edit");
      expect(
        container.querySelector('[data-code-visible="true"]'),
      ).not.toBeNull();
      expect(api.saveExplorerFile).not.toHaveBeenCalled();
      expect(api.updateExplorerViewState).not.toHaveBeenCalled();
    },
  );
  it("keeps a Visual draft across View, then saves it to the same path before Edit", async () => {
    await setup("data/settings.yaml");
    await choose("visual");
    await act(async () =>
      container
        .querySelector<HTMLElement>('[aria-label="Edit enabled"]')!
        .click(),
    );
    expect(header!.dirty).toBe(true);
    await choose("preview");
    expect(container.querySelector("pre")?.textContent).toContain("false");
    expect(api.saveExplorerFile).not.toHaveBeenCalled();
    vi.mocked(api.saveExplorerFile).mockResolvedValue({
      path: "data/settings.yaml",
      content: "enabled: false\nnested:\n  value: 42\n",
      markdown: false,
      version: "two",
    } as Awaited<ReturnType<typeof api.saveExplorerFile>>);
    await choose("edit");
    expect(api.saveExplorerFile).toHaveBeenCalledWith(
      "explorer-one",
      expect.objectContaining({
        path: "data/settings.yaml",
        content: expect.stringContaining("false"),
        version: "one",
      }),
    );
  });
  it("preserves selected mode for the same transient path during persisted metadata updates", async () => {
    const render = await setup("data/settings.yaml");
    await choose("visual");
    await act(async () =>
      container
        .querySelector<HTMLElement>('[aria-label="Edit enabled"]')!
        .click(),
    );
    await render({ ...explorer, fileMode: "edit" });
    expect(header!.fileMode).toBe("visual");
    expect(header!.dirty).toBe(true);
    expect(
      container
        .querySelector('[aria-label="Edit enabled"]')
        ?.getAttribute("aria-checked"),
    ).toBe("false");
    expect(api.saveExplorerFile).not.toHaveBeenCalled();
  });
  it("resets a new transient path to its default and restores the prior pinned selection on close", async () => {
    const original = {
      ...explorer,
      selectedPath: "README.md",
      fileMode: "preview" as const,
    };
    const render = await setup("data/settings.yaml", original);
    await render(original, null);
    await render(original, "data/settings.yaml");
    await choose("visual");
    await render(original, "data/settings.json");
    expect(header!.fileMode).toBe("edit");
    expect(
      container
        .querySelector('[data-code-visible="true"]')
        ?.getAttribute("data-code-path"),
    ).toBe("data/settings.json");
    await render(original, null);
    expect(header!.selectedPath).toBe("README.md");
    expect(header!.fileMode).toBe("preview");
    expect(api.saveExplorerFile).not.toHaveBeenCalled();
  });
  it.each(["edit", "visual"] as const)(
    "hands a preview to the persisted pinned %s mode without writing file bytes",
    async (fileMode) => {
      const render = await setup("data/settings.yaml");
      await choose("visual");
      const pinned = {
        ...explorer,
        selectedPath: "data/settings.yaml",
        fileMode,
      };
      await render(pinned);
      expect(header!.fileMode).toBe("visual");
      await render(pinned, null);
      expect(header!.selectedPath).toBe("data/settings.yaml");
      expect(header!.fileMode).toBe(fileMode);
      expect(
        container.querySelector('[aria-label="Search structured values"]') !==
          null,
      ).toBe(fileMode === "visual");
      expect(
        container.querySelector('[data-code-visible="true"]') !== null,
      ).toBe(fileMode === "edit");
      expect(api.saveExplorerFile).not.toHaveBeenCalled();
    },
  );
});
