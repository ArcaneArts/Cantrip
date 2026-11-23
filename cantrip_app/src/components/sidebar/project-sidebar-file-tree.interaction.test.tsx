// @vitest-environment jsdom
import type { ExplorerEntry, ExplorerSummary } from "@cantrip/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  entries: new Map<string, ExplorerEntry[]>(),
  bindingKey: "binding",
}));

vi.mock("@/lib/client-session", () => ({
  getClientSession: () => ({ serverId: "server", user: { id: "owner" } }),
  onClientSessionIdentityChanged: () => () => {},
}));
vi.mock("./use-file-change-activity", () => ({
  useFileChangeActivity: () => ({ current: null }),
}));
vi.mock("@/components/explorer/use-explorer-worker-encryption", () => ({
  useExplorerWorkerEncryption: () => ({
    ready: true,
    bindingKey: runtime.bindingKey,
    continuityKey: "worker",
    error: null,
  }),
}));
vi.mock("@/components/explorer/use-explorer-directory", () => ({
  useExplorerDirectory: ({ path }: { path: string }) => ({
    directory: { isLoading: false, isError: false },
    entries: runtime.entries.get(path) ?? [],
  }),
}));

import { ProjectSidebarFileTree } from "./project-sidebar-file-tree";
import type { SidebarFileImporter } from "./sidebar-file-drop";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const onRename = vi.fn(async () => {});

function folder(path: string): ExplorerEntry {
  return {
    kind: "directory",
    name: path.split("/").at(-1)!,
    path,
    markdown: false,
    modifiedAt: "2026-10-31T00:00:00.000Z",
    size: null,
    symbolicLink: false,
    viewable: false,
  };
}

async function flush() {
  // Radix restores focus after its closing focus scope is unmounted.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

async function mount(
  createWait?: Promise<void>,
  onImportFiles?: SidebarFileImporter,
  onOpenAs?: (entry: ExplorerEntry, viewer: string | null) => void,
) {
  await act(async () => {
    root.render(
      <ProjectSidebarFileTree
        activePath={null}
        explorer={
          {
            id: "explorer",
            projectId: "project",
            worktreeId: "worktree",
            activeWorkerId: "worker",
          } as ExplorerSummary
        }
        loading={false}
        onImportFiles={onImportFiles}
        onOpenAs={onOpenAs}
        onCreateFolder={async (parent) => {
          if (createWait) await createWait;
          const created = folder(
            parent ? `${parent}/New Folder` : "New Folder",
          );
          runtime.entries.set(parent, [
            ...(runtime.entries.get(parent) ?? []),
            created,
          ]);
          return created;
        }}
        onCreateFile={async () => {
          throw new Error("unused");
        }}
        onDelete={async () => {}}
        onPin={() => {}}
        onPreview={() => {}}
        onRename={onRename}
        workerId="worker"
        workerOnline
      />,
    );
  });
}

async function openMenu(element: Element) {
  await act(async () => {
    // A sidebar row can already own focus when opening the background menu.
    (element.getAttribute("role") === "tree"
      ? host.querySelector<HTMLElement>('[role="treeitem"]')
      : (element as HTMLElement)
    )?.focus();
    element.dispatchEvent(
      new MouseEvent("contextmenu", { button: 2, bubbles: true }),
    );
  });
  await flush();
}

async function choose(label: string) {
  const item = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find(
    (item) =>
      item.getAttribute("aria-label") === label ||
      item.textContent?.trim() === label,
  );
  expect(item, `menu item ${label}`).toBeDefined();
  await act(async () => item!.click());
  await flush();
}

function expectSelectedName(name: string) {
  const input = host.querySelector<HTMLInputElement>(
    `input[aria-label="Rename ${name}"]`,
  );
  expect(input).not.toBeNull();
  expect(document.activeElement).toBe(input);
  expect(input!.selectionStart).toBe(0);
  expect(input!.selectionEnd).toBe(name.length);
  expect(onRename).not.toHaveBeenCalled();
  return input!;
}

beforeEach(() => {
  runtime.entries.clear();
  runtime.bindingKey = "binding";
  runtime.entries.set("", [folder("src")]);
  localStorage.clear();
  onRename.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await flush();
  host.remove();
});

it.each([
  ["", false],
  ["src", false],
  ["", true],
  ["src", true],
] as const)(
  "keeps a new folder in %j focused and selected (deferred creation: %j)",
  async (parent, deferred) => {
    let finishCreate!: () => void;
    const created = new Promise<void>((resolve) => {
      finishCreate = resolve;
    });
    await mount(deferred ? created : undefined);
    await openMenu(
      host.querySelector(parent ? '[role="treeitem"]' : '[role="tree"]')!,
    );
    await choose(
      parent ? `Create folder in ${parent}` : "Create folder in project root",
    );
    if (deferred) {
      expect(host.querySelector("input")).toBeNull();
      await act(async () => finishCreate());
      await flush();
    }
    expectSelectedName("New Folder");
  },
);

it.each(["directory", "file"] as const)(
  "selects the whole existing %s name after the Rename menu closes",
  async (kind) => {
    const name = kind === "directory" ? "New Folder" : "example.ts";
    runtime.entries.set("", [
      { ...folder(name), kind, viewable: kind === "file" },
    ]);
    await mount();
    await openMenu(host.querySelector('[role="treeitem"]')!);
    await choose("Rename");
    const input = expectSelectedName(name);
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    await flush();
    expect(host.querySelector("input")).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  },
);

it.each(["", "src"])(
  "keeps new-file naming in %j focused after the same menu handoff",
  async (parent) => {
    await mount();
    await openMenu(
      host.querySelector(parent ? '[role="treeitem"]' : '[role="tree"]')!,
    );
    await choose(
      parent ? `Create file in ${parent}` : "Create file in project root",
    );
    const input = host.querySelector<HTMLInputElement>(
      'input[aria-label="New file name"]',
    );
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  },
);

it("restores row focus without starting an action when the menu is dismissed", async () => {
  await mount();
  const row = host.querySelector<HTMLElement>('[role="treeitem"]')!;
  await openMenu(row);
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
  await act(async () =>
    menu.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  await flush();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(row);
  expect(host.querySelector("input")).toBeNull();
  expect(runtime.entries.get("")).toHaveLength(1);
});

async function drag(
  element: Element,
  type: string,
  dataTransfer: Partial<Omit<DataTransfer, "items">> & {
    items?: ArrayLike<DataTransferItem>;
  },
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: [], items: [], files: [], ...dataTransfer },
  });
  await act(async () => {
    element.dispatchEvent(event);
  });
  return event;
}

it.each(["", "src"])(
  "drops external files into %j with copy feedback and progress",
  async (parent) => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const importer = vi.fn<SidebarFileImporter>(
      async (_path, _files, _auth, onProgress) => {
        onProgress({
          name: "photo.png",
          completed: 2,
          total: 4,
          index: 0,
          count: 1,
        });
        await pending;
      },
    );
    await mount(undefined, importer);
    const target = host.querySelector(
      parent ? '[role="treeitem"]' : '[role="tree"]',
    )!;
    const file = new File([new Uint8Array([0, 255, 128, 10])], "photo.png");
    const dataTransfer = {
      types: ["Files"],
      items: [{ kind: "file" }] as DataTransferItem[],
      files: [file] as unknown as FileList,
      dropEffect: "none" as DataTransfer["dropEffect"],
    };
    expect(
      (await drag(target, "dragover", dataTransfer)).defaultPrevented,
    ).toBe(true);
    expect(host.querySelector("[data-file-drop-target]")).not.toBeNull();
    expect(host.textContent).toContain(
      `Drop files into ${parent || "project root"}`,
    );
    await drag(target, "drop", dataTransfer);
    expect(importer).toHaveBeenCalledExactlyOnceWith(
      parent,
      [file],
      expect.objectContaining({ isCurrent: expect.any(Function) }),
      expect.any(Function),
    );
    expect(host.querySelector("[data-file-drop-target]")).toBeNull();
    expect(host.textContent).toContain("Adding 1 of 1: photo.png (50%)");
    await drag(target, "drop", dataTransfer);
    expect(importer).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(host.textContent).not.toContain("Adding 1 of 1");
  },
);

it("leaves text and workspace-tab drags alone and clears file-drop feedback on leave", async () => {
  const importer = vi.fn<SidebarFileImporter>();
  await mount(undefined, importer);
  const tree = host.querySelector('[role="tree"]')!;
  expect(
    (await drag(tree, "dragover", { types: ["text/plain"] })).defaultPrevented,
  ).toBe(false);
  expect(
    (
      await drag(tree, "drop", {
        types: ["application/x-cantrip-workspace-tab"],
      })
    ).defaultPrevented,
  ).toBe(false);
  await drag(tree, "dragover", { types: ["Files"] });
  await drag(tree, "dragleave", { types: ["Files"] });
  expect(host.querySelector("[data-file-drop-target]")).toBeNull();
  expect(importer).not.toHaveBeenCalled();
});

it("reports directory drops and import failures without navigating away", async () => {
  const importer = vi.fn<SidebarFileImporter>(async () => {
    throw new Error("photo.png already exists");
  });
  await mount(undefined, importer);
  const tree = host.querySelector('[role="tree"]')!;
  const file = new File(["data"], "photo.png");
  const files = [file] as unknown as FileList;
  await drag(tree, "drop", {
    types: ["Files"],
    files,
    items: [
      { kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }) },
    ] as DataTransferItem[],
  });
  expect(host.textContent).toContain("folder uploads are not supported");
  expect(importer).not.toHaveBeenCalled();
  expect(
    (await drag(tree, "drop", { types: ["Files"], files })).defaultPrevented,
  ).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "photo.png already exists",
  );
});

it("retires an unfinished drop when its project binding changes", async () => {
  let fail!: (error: Error) => void;
  const importer = vi.fn<SidebarFileImporter>(
    () =>
      new Promise<void>((_, reject) => {
        fail = reject;
      }),
  );
  await mount(undefined, importer);
  await drag(host.querySelector('[role="tree"]')!, "drop", {
    types: ["Files"],
    files: [new File(["data"], "name.bin")] as unknown as FileList,
  });
  const authorization = importer.mock.calls[0]![2];
  expect(authorization.isCurrent()).toBe(true);
  runtime.bindingKey = "other-project";
  await mount(undefined, importer);
  expect(authorization.isCurrent()).toBe(false);
  await act(async () => fail(new Error("old failure")));
  expect(host.textContent).not.toContain("old failure");
  expect(host.textContent).not.toContain("Adding");
});

it("offers Open As on an unknown file without requiring ordinary preview support", async () => {
  const entry = {
    ...folder("opaque.xyz"),
    kind: "file" as const,
    viewable: false,
    size: 10,
  };
  runtime.entries.set("", [entry]);
  const onOpenAs = vi.fn();
  await mount(undefined, undefined, onOpenAs);
  await openMenu(host.querySelector('[role="treeitem"]')!);
  const trigger = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((item) => item.textContent?.trim() === "Open As")!;
  expect(trigger).toBeDefined();
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
  });
  await flush();
  await choose("JSON");
  expect(onOpenAs).toHaveBeenCalledWith(entry, "json");
});
