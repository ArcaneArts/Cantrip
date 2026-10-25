// @vitest-environment jsdom
import type { ExplorerEntry, ExplorerSummary } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import {
  ExplorerView,
  type ExplorerHeaderState,
  type ExplorerLifecycleActions,
} from "./explorer-view";
vi.mock("@/components/explorer/explorer-file-browser", () => ({
  ExplorerFileBrowser: ({
    onOpenFile,
  }: {
    onOpenFile(entry: ExplorerEntry): void;
  }) =>
    createElement("button", {
      "aria-label": "Open source file",
      onClick: () =>
        onOpenFile({
          kind: "file",
          path: "src/main.ts",
          viewable: true,
        } as ExplorerEntry),
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
let lifecycle: ExplorerLifecycleActions | null;
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
  "src/main.ts": "export const ready = true;\n",
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
            onLifecycleChange={(_id, actions) => {
              lifecycle = actions;
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
describe("Explorer renderer modes", () => {
  it("refuses replacement while dirty or saving and permits it after save succeeds", async () => {
    await setup("data/settings.yaml");
    await choose("visual");
    await act(async () => {
      container
        .querySelector<HTMLElement>('[aria-label="Edit enabled"]')!
        .click();
    });
    expect(header!.dirty).toBe(true);
    expect(lifecycle!.reservePreviewReplacement!()).toBeNull();
    await choose("edit");
    const input = container.querySelector("textarea")!;
    const draft = input.value;
    let finishSave!: (
      value: Awaited<ReturnType<typeof api.saveExplorerFile>>,
    ) => void;
    vi.mocked(api.saveExplorerFile).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    let saving!: Promise<unknown>;
    await act(async () => {
      saving = header!.save();
    });
    expect(api.saveExplorerFile).toHaveBeenCalledOnce();
    expect(lifecycle!.reservePreviewReplacement!()).toBeNull();
    expect(input.value).toBe(draft);
    expect(input.readOnly).toBe(false);
    await act(async () => {
      finishSave({
        path: "data/settings.yaml",
        content: draft,
        markdown: false,
        version: "two",
      } as Awaited<ReturnType<typeof api.saveExplorerFile>>);
      await saving;
    });
    expect(header!.dirty).toBe(false);
    let release: (() => void) | null = null;
    await act(async () => {
      release = lifecycle!.reservePreviewReplacement!();
    });
    expect(release).toBeTypeOf("function");
    await act(async () => {
      release!();
    });
    expect(input.value).toBe(draft);
  });

  it("freezes a clean preview during replacement and restores editing on release", async () => {
    await setup("src/main.ts");
    await choose("edit");
    const input = container.querySelector("textarea")!;
    expect(input.readOnly).toBe(false);
    let release: (() => void) | null = null;
    await act(async () => {
      release = lifecycle!.reservePreviewReplacement!();
    });
    expect(release).toBeTypeOf("function");
    expect(input.readOnly).toBe(true);
    expect(lifecycle!.reservePreviewReplacement!()).toBeNull();
    await act(async () => {
      release!();
      release!();
    });
    expect(container.querySelector("textarea")).toBe(input);
    expect(input.readOnly).toBe(false);
    expect(input.value).toBe(contents["src/main.ts"]);
  });

  it("keeps an inline code file in Edit while its saved summary is still the old browser state", async () => {
    const render = await setup("");
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Open source file"]')!
        .click();
    });
    await settle();
    expect(api.updateExplorerViewState).toHaveBeenCalledWith(explorer.id, {
      selectedPath: "src/main.ts",
      fileMode: "edit",
    });
    expect(header!.selectedPath).toBe("src/main.ts");
    expect(header!.fileMode).toBe("edit");
    expect(container.querySelector("textarea")?.readOnly).toBe(false);
    const input = container.querySelector("textarea");
    // A cache notification can publish another copy of the old summary before
    // the acknowledged state reaches this owner.
    await render({ ...explorer }, null);
    expect(header!.fileMode).toBe("edit");
    expect(header!.selectedPath).toBe("src/main.ts");
    await render(
      { ...explorer, selectedPath: "src/main.ts", fileMode: "edit" },
      null,
    );
    expect(container.querySelector("textarea")).toBe(input);
    expect(api.updateExplorerViewState).toHaveBeenCalledTimes(1);
  });

  it("does not roll an inline mode choice back while waiting for updated props", async () => {
    const initial = { ...explorer, selectedPath: "src/main.ts" };
    const render = await setup("", initial);
    await choose("edit");
    expect(container.querySelector("textarea")?.readOnly).toBe(false);
    await render({ ...initial, fileMode: "edit" }, null);
    await choose("preview");
    expect(container.querySelector("textarea")?.readOnly).toBe(true);
    await render(initial, null);
    expect(header!.fileMode).toBe("preview");
  });

  it("retains inline Edit and reports a failed view-state save instead of reverting the open", async () => {
    await setup("");
    vi.mocked(api.updateExplorerViewState).mockRejectedValueOnce(
      new Error("Timed out saving view state"),
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Open source file"]')!
        .click();
    });
    await settle();
    expect(header!.selectedPath).toBe("src/main.ts");
    expect(header!.fileMode).toBe("edit");
    expect(container.querySelector("textarea")?.readOnly).toBe(false);
    expect(container.textContent).toContain("Timed out saving view state");
  });

  it("still applies a genuinely changed persisted mode after opening inline", async () => {
    const initial = {
      ...explorer,
      selectedPath: "src/main.ts",
      fileMode: "edit" as const,
    };
    const render = await setup("", initial);
    await render({ ...initial, fileMode: "preview" }, null);
    expect(header!.fileMode).toBe("preview");
    expect(container.querySelector("textarea")?.readOnly).toBe(true);
  });

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
