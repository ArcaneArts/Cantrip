// @vitest-environment jsdom
import type { CodeTabSummary, ExplorerEntry } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorDocumentSession } from "@/components/editor/document-session";
import {
  EditorSessionStore,
  editorDocumentId,
} from "@/components/editor/document-session";
import type { ExplorerTransferState } from "@/components/explorer/explorer-view";

const api = vi.hoisted(() => ({
  getExplorerFile: vi.fn(),
  saveExplorerFile: vi.fn(),
  loadExplorerMedia: vi.fn(),
  updateExplorerViewState: vi.fn(),
}));
const editor = vi.hoisted(() => ({
  current: null as {
    session: EditorDocumentSession;
    onChange(text: string): void;
    readOnly?: boolean;
  } | null,
}));
vi.mock("@/lib/api", () => api);
vi.mock("@/lib/client-session", () => ({
  getClientSession: () => ({ serverId: "server", user: { id: "owner" } }),
}));
vi.mock("@/components/editor/native-code-editor", () => ({
  NativeCodeEditor: (props: NonNullable<typeof editor.current>) => {
    editor.current = props;
    return createElement("div", {
      "data-native-editor": true,
      "data-readonly": props.readOnly ?? false,
    });
  },
}));
vi.mock("@/components/explorer/explorer-file-browser", () => ({
  ExplorerFileBrowser: ({
    onOpenFile,
  }: {
    onOpenFile(entry: ExplorerEntry): void;
  }) =>
    createElement("button", {
      "data-open-file": true,
      onClick: () =>
        onOpenFile({
          path: "main.ts",
          name: "main.ts",
          kind: "file",
          viewable: true,
          markdown: false,
          symbolicLink: false,
          size: 8,
          modifiedAt: "2026-10-22T00:00:00Z",
        }),
    }),
}));
vi.mock("@/components/explorer/use-explorer-worker-encryption", () => ({
  useExplorerWorkerEncryption: () => ({
    bindingKey: "scope",
    error: null,
    ready: true,
    retry: vi.fn(),
  }),
}));
vi.mock("@/components/git/git-graph", () => ({
  GitRepositoryGraphView: () => null,
}));
vi.mock("@/lib/client-log-relay", () => ({
  clientLogger: { info: vi.fn(), warn: vi.fn() },
}));
import { CodeView, type CodeHeaderState } from "./code-view";
import {
  confirmNativeCodeDiscard,
  prepareNativeCodeTransfer,
} from "./native-code-lifecycle";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const tab = {
  id: "native-code-tab",
  projectId: "project-one",
  worktreeId: "worktree-one",
  activeWorkerId: "worker-one",
  title: "Code",
  position: 0,
  createdAt: "2026-10-22T00:00:00Z",
  updatedAt: "2026-10-22T00:00:00Z",
} as CodeTabSummary;
let renderer: TestRenderer.ReactTestRenderer;
let client: QueryClient;
let header: CodeHeaderState | null;
const onHeader = (value: CodeHeaderState | null) => {
  header = value;
};
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
}
async function render(next = tab, initialTransfer?: ExplorerTransferState) {
  const tree = (
    <QueryClientProvider client={client}>
      <CodeView
        codeTab={next}
        appearance="dark"
        onHeaderChange={onHeader}
        initialTransfer={initialTransfer}
      />
    </QueryClientProvider>
  );
  await act(async () => {
    if (renderer) renderer.update(tree);
    else renderer = TestRenderer.create(tree);
  });
  await settle();
}
async function open() {
  await act(async () =>
    renderer.root.findByProps({ "data-open-file": true }).props.onClick(),
  );
  await settle();
  await vi.waitFor(() => expect(editor.current).not.toBeNull());
}
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderer = undefined as unknown as TestRenderer.ReactTestRenderer;
  header = null;
  editor.current = null;
  api.getExplorerFile.mockResolvedValue({
    path: "main.ts",
    content: "const x = 1;",
    markdown: false,
    version: "one",
  });
  api.saveExplorerFile.mockImplementation(async (_id, input) => ({
    ...input,
    markdown: false,
    version: "two",
  }));
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  client.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("native project Code tabs", () => {
  it("opens the transferred selected file and unsaved content without a browser click", async () => {
    const store = new EditorSessionStore();
    store.resetScope('["server","owner"]');
    const document = store.open(
      editorDocumentId({
        server: "server",
        account: "owner",
        worker: tab.activeWorkerId,
        project: tab.projectId,
        worktree: tab.worktreeId,
        path: "main.ts",
      }),
      "original",
      "one",
    );
    document.editExternal("unsaved transferred Code draft");
    await render(tab, {
      explorerId: tab.id,
      projectId: tab.projectId,
      workerId: tab.activeWorkerId,
      worktreeId: tab.worktreeId,
      selectedPath: "main.ts",
      fileMode: "edit",
      documents: await store.captureTransfer(),
    });
    expect(editor.current?.session.text).toBe("unsaved transferred Code draft");
    expect(header?.explorer?.selectedPath).toBe("main.ts");
    expect(header?.explorer?.dirty).toBe(true);
    expect(api.saveExplorerFile).not.toHaveBeenCalled();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => header!.explorer!.back());
    await settle();
    expect(
      renderer.root.findAllByProps({ "data-open-file": true }),
    ).toHaveLength(1);
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  });
  it("opens, views, edits and explicitly saves through the existing bound file API", async () => {
    await render();
    await open();
    const session = editor.current!.session;
    expect(renderer.root.findAllByType("iframe")).toHaveLength(0);
    expect(api.getExplorerFile).toHaveBeenCalledWith(tab.id, "main.ts", {
      projectId: tab.projectId,
      workerId: tab.activeWorkerId,
      worktreeId: tab.worktreeId,
    });
    await act(async () => editor.current!.onChange("const draft = 2;"));
    await act(async () => header!.explorer!.setFileMode("preview"));
    await settle();
    expect(editor.current!.readOnly).toBe(true);
    expect(editor.current!.session).toBe(session);
    expect(session.text).toBe("const draft = 2;");
    expect(api.saveExplorerFile).not.toHaveBeenCalled();
    await act(async () => header!.explorer!.setFileMode("edit"));
    await settle();
    await act(async () => {
      await header!.explorer!.save();
    });
    expect(api.saveExplorerFile).toHaveBeenCalledWith(
      tab.id,
      { path: "main.ts", content: "const draft = 2;", version: "one" },
      {
        projectId: tab.projectId,
        workerId: tab.activeWorkerId,
        worktreeId: tab.worktreeId,
      },
    );
    expect(session.dirty).toBe(false);
    expect(api.updateExplorerViewState).not.toHaveBeenCalled();
    await act(async () => header!.explorer!.back());
    await settle();
    expect(
      renderer.root.findAllByProps({ "data-open-file": true }),
    ).toHaveLength(1);
  });
  it("keeps a dirty tab open on canceled close or worktree change", async () => {
    await render();
    await open();
    await act(async () => editor.current!.onChange("unsaved draft"));
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await expect(confirmNativeCodeDiscard(tab.id)).resolves.toBe(false);
    await expect(prepareNativeCodeTransfer(tab.id)).resolves.toBe(false);
    expect(editor.current!.session.text).toBe("unsaved draft");
    expect(api.saveExplorerFile).not.toHaveBeenCalled();
  });
  it("saves to the original checkout before an approved worktree change", async () => {
    await render();
    await open();
    const session = editor.current!.session;
    await act(async () => editor.current!.onChange("saved before move"));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => {
      expect(await prepareNativeCodeTransfer(tab.id)).toBe(true);
    });
    expect(session.dirty).toBe(false);
    expect(api.saveExplorerFile.mock.calls[0]![2].worktreeId).toBe(
      "worktree-one",
    );
    await render({ ...tab, worktreeId: "other-worktree" });
    expect(
      renderer.root.findAllByProps({ "data-open-file": true }),
    ).toHaveLength(1);
  });
  it("retains a dirty document when another client moves the tab", async () => {
    await render();
    await open();
    const session = editor.current!.session;
    await act(async () => editor.current!.onChange("keep original draft"));
    await render({
      ...tab,
      worktreeId: "other-worktree",
      activeWorkerId: "other-worker",
    });
    expect(editor.current!.session).toBe(session);
    expect(session.text).toBe("keep original draft");
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(1);
    api.saveExplorerFile.mockRejectedValueOnce(
      new Error("This file belongs to another checkout."),
    );
    await act(async () => {
      expect(await header!.explorer!.save()).toBe(false);
    });
    expect(api.saveExplorerFile.mock.calls[0]![2].worktreeId).toBe(
      "worktree-one",
    );
    expect(session.dirty).toBe(true);
  });
});
