// @vitest-environment jsdom
import type { ExplorerEntry, ExplorerSummary } from "@cantrip/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  entries: new Map<string, ExplorerEntry[]>(),
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
    bindingKey: "binding",
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

async function mount(createWait?: Promise<void>) {
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
