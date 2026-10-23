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
  clientLogger: { info: vi.fn(), warn: vi.fn() },
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let client: QueryClient;
let container: HTMLDivElement;
let header: ExplorerHeaderState | null;
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
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
  it("leaves file-tab closing to the tab while retaining transient preview navigation", async () => {
    const render = await setup("README.md", {
      ...explorer,
      selectedPath: "README.md",
    });
    expect(header!.showFileClose).toBe(true);
    expect(
      container.querySelector('button[aria-label="Close file"]'),
    ).not.toBeNull();

    await render({ ...explorer, selectedPath: "README.md" }, null);
    expect(header!.selectedPath).toBe("README.md");
    expect(header!.showFileClose).toBe(false);
    expect(
      container.querySelector('button[aria-label="Close file"]'),
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="Refresh Explorer"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="View mode"]'),
    ).not.toBeNull();
  });

  it.each(["data/settings.yaml", "data/settings.json"])(
    "renders selected Visual/View/Edit independently of Code readiness: %s",
    async (path) => {
      await setup(path);
      expect(
        container.querySelector('[data-native-code-editor="true"]'),
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
      expect(container.querySelector("textarea")?.value).toContain("enabled");
      expect(container.querySelector("textarea")?.readOnly).toBe(true);
      expect(container.querySelector("pre")).toBeNull();
      expect(
        container.querySelector('[aria-label="Search structured values"]'),
      ).toBeNull();
      await choose("edit");
      expect(
        container.querySelector('[data-native-code-editor="true"]'),
      ).not.toBeNull();
      expect(container.querySelector("textarea")?.readOnly).toBe(false);
      expect(api.saveExplorerFile).not.toHaveBeenCalled();
      expect(api.updateExplorerViewState).not.toHaveBeenCalled();
    },
  );
  it("keeps a Visual draft across View/Edit and saves only on an explicit save", async () => {
    await setup("data/settings.yaml");
    await choose("visual");
    await act(async () =>
      container
        .querySelector<HTMLElement>('[aria-label="Edit enabled"]')!
        .click(),
    );
    expect(header!.dirty).toBe(true);
    await choose("preview");
    expect(container.querySelector("textarea")?.value).toContain("false");
    expect(container.querySelector("textarea")?.readOnly).toBe(true);
    const input = container.querySelector("textarea")!;
    await act(async () => {
      for (const key of ["z", "y", "s"]) {
        const event = new KeyboardEvent("keydown", {
          key,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        });
        input.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
      const event = new InputEvent("beforeinput", {
        inputType: "historyUndo",
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });
    expect(input.value).toContain("false");
    expect(api.saveExplorerFile).not.toHaveBeenCalled();
    vi.mocked(api.saveExplorerFile).mockResolvedValue({
      path: "data/settings.yaml",
      content: "enabled: false\nnested:\n  value: 42\n",
      markdown: false,
      version: "two",
    } as Awaited<ReturnType<typeof api.saveExplorerFile>>);
    await choose("edit");
    expect(container.querySelector("textarea")).toBe(input);
    expect(input.readOnly).toBe(false);
    expect(api.saveExplorerFile).not.toHaveBeenCalled();
    expect(container.querySelector("textarea")?.value).toContain("false");
    await act(async () => {
      await header!.save();
    });
    expect(api.saveExplorerFile).toHaveBeenCalledWith(
      "explorer-one",
      expect.objectContaining({
        path: "data/settings.yaml",
        content: expect.stringContaining("false"),
        version: "one",
      }),
      {
        workerId: explorer.activeWorkerId,
        projectId: explorer.projectId,
        worktreeId: explorer.worktreeId,
      },
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
      container.querySelector("textarea")?.getAttribute("aria-label"),
    ).toBe("Edit settings.json");
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
        container.querySelector('[data-native-code-editor="true"]') !== null,
      ).toBe(fileMode === "edit");
      expect(api.saveExplorerFile).not.toHaveBeenCalled();
    },
  );
});
