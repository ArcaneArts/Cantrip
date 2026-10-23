// @vitest-environment jsdom
import type { ExplorerSummary } from "@cantrip/protocol";
import type { EditorDocumentSession } from "@/components/editor/document-session";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  publishHeader: true,
  ready: true,
  owner: "owner-one",
  content: "original\n",
  header: null as unknown,
  lifecycle: null as unknown,
  input: null as unknown,
  transientPath: undefined as string | undefined,
}));
const api = vi.hoisted(() => ({
  getExplorerFile: vi.fn(),
  saveExplorerFile: vi.fn(),
  loadExplorerMedia: vi.fn(),
  updateExplorerViewState: vi.fn(),
}));
vi.mock("@/lib/api", () => api);
vi.mock("@/lib/client-session", () => ({
  getClientSession: () => ({
    serverId: "server-one",
    user: { id: state.owner },
  }),
}));
vi.mock("@/lib/client-log-relay", () => ({
  clientLogger: { info: vi.fn(), warn: vi.fn() },
}));
vi.mock("@/components/explorer/use-explorer-worker-encryption", () => ({
  useExplorerWorkerEncryption: (explorer: ExplorerSummary) => ({
    ready: state.ready,
    bindingKey: JSON.stringify([
      state.owner,
      explorer.activeWorkerId,
      explorer.worktreeId,
    ]),
    error: null,
    retry: vi.fn(),
  }),
}));
vi.mock("@/components/explorer/explorer-file-browser", () => ({
  ExplorerFileBrowser: () => null,
}));
vi.mock("@/components/git/git-graph", () => ({
  GitRepositoryGraphView: () => null,
}));
interface InputProps {
  session: EditorDocumentSession;
  path: string;
  onChange(text: string): void;
}
vi.mock("@/components/editor/native-code-editor", () => ({
  NativeCodeEditor: (props: InputProps) => {
    state.input = props;
    return createElement("textarea", {
      "data-document-id": props.session.id,
      value: props.session.text,
      readOnly: true,
    });
  },
}));
import {
  ExplorerView,
  type ExplorerHeaderState,
  type ExplorerLifecycleActions,
} from "./explorer-view";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: TestRenderer.ReactTestRenderer | null = null;
let client: QueryClient;
const summary = {
  id: "explorer-one",
  projectId: "project-one",
  worktreeId: "worktree-one",
  activeWorkerId: "worker-one",
  selectedPath: "source.ts",
  fileMode: "edit",
} as ExplorerSummary;
const header = () => state.header as ExplorerHeaderState;
const input = () => state.input as InputProps;
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
function tree(explorer = summary) {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(ExplorerView, {
      appearance: "dark",
      explorer,
      repositoryGraphAvailable: false,
      transientFile: state.transientPath
        ? { path: state.transientPath, close: vi.fn() }
        : undefined,
      onHeaderChange: (value) => {
        if (state.publishHeader) state.header = value;
      },
      onLifecycleChange: (_id, value) => {
        state.lifecycle = value;
      },
    }),
  );
}
async function render(explorer = summary) {
  await act(async () => {
    if (renderer) renderer.update(tree(explorer));
    else renderer = TestRenderer.create(tree(explorer));
  });
  await settle();
}
async function edit(text: string) {
  await act(async () => {
    input().session.edit(text);
    input().onChange(text);
  });
}
beforeEach(() => {
  state.publishHeader = true;
  state.ready = true;
  state.owner = "owner-one";
  state.content = "original\n";
  state.input = null;
  state.header = null;
  state.lifecycle = null;
  state.transientPath = undefined;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.getExplorerFile.mockReset();
  api.saveExplorerFile.mockReset();
  api.getExplorerFile.mockImplementation(async (_id, path) => ({
    path,
    content: state.content,
    version: "version-one",
    markdown: false,
  }));
  api.saveExplorerFile.mockImplementation(async (_id, value) => ({
    ...value,
    version: "version-two",
    markdown: false,
  }));
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  client.clear();
});

describe("native Explorer document integration", () => {
  it("saves through its own toolbar without publishing a focused shell header", async () => {
    state.publishHeader = false;
    await render();
    await edit("saved from the unfocused panel\n");
    expect(state.header).toBeNull();
    const save = renderer!.root
      .findAllByType("button")
      .find((node) => node.props["aria-label"] === "Save file")!;
    expect(save.props.disabled).toBe(false);
    await act(async () => save.props.onClick());
    await settle();
    expect(api.saveExplorerFile).toHaveBeenCalledWith(
      summary.id,
      expect.objectContaining({
        path: "source.ts",
        content: "saved from the unfocused panel\n",
      }),
      expect.anything(),
    );
  });
  it("opens licenses as documents and retains the same editable draft across Preview/Edit", async () => {
    state.transientPath = "LICENSE";
    state.content = "Copyright (c) 2026 Arcane Arts\nAll rights reserved.\n";
    await render();
    expect(header().fileMode).toBe("preview");
    expect(renderer!.root.findAllByType("textarea")).toHaveLength(0);
    expect(
      renderer!.root
        .findByProps({ "aria-label": "License text" })
        .children.join(""),
    ).toBe(state.content);
    await act(async () => header().setFileMode("edit"));
    const original = input().session;
    await edit(state.content + "\nA custom notice.");
    await act(async () => header().setFileMode("preview"));
    expect(
      renderer!.root
        .findByProps({ "aria-label": "License text" })
        .children.join(""),
    ).toBe(original.text);
    expect(api.saveExplorerFile).not.toHaveBeenCalled();
    await act(async () => header().setFileMode("edit"));
    expect(input().session).toBe(original);
    expect(header().dirty).toBe(true);
    await act(async () => {
      expect(await header().save()).toBe(true);
    });
    expect(api.saveExplorerFile).toHaveBeenCalledTimes(1);
  });
  it("does not install the previous file's cached read into a newly requested sidebar document", async () => {
    await render();
    expect(input().session.text).toBe("original\n");
    api.getExplorerFile.mockImplementation(async (_id, path) => ({
      path,
      content: `${path} content`,
      version: `${path}-version`,
      markdown: false,
    }));
    state.transientPath = "unknown.custom";
    await render();
    expect(input().path).toBe("unknown.custom");
    expect(input().session.text).toBe("unknown.custom content");
    expect(input().session.version).toBe("unknown.custom-version");
  });
  it("keeps the document editable offline and attempts the actual protected save", async () => {
    await render();
    await edit("offline draft");
    const document = input().session;
    state.ready = false;
    await render();
    expect(renderer!.root.findAllByType("textarea")).toHaveLength(1);
    expect(input().session).toBe(document);
    api.saveExplorerFile.mockRejectedValueOnce(new Error("Worker is offline"));
    let saved: boolean | undefined;
    await act(async () => {
      saved = await header().save();
    });
    expect(saved).toBe(false);
    expect(api.saveExplorerFile).toHaveBeenCalledTimes(1);
    expect(document.text).toBe("offline draft");
    expect(document.dirty).toBe(true);
    state.ready = true;
    await render();
    await act(async () => {
      saved = await header().save();
    });
    expect(saved).toBe(true);
    expect(document.dirty).toBe(false);
  });
  it("retains typing performed during a save and uses the returned revision for the next save", async () => {
    await render();
    await edit("first edit");
    let finish!: (value: unknown) => void;
    api.saveExplorerFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = header().save();
    });
    await edit("second edit");
    await act(async () => {
      finish({
        path: "source.ts",
        content: "first edit",
        version: "version-two",
        markdown: false,
      });
      await pending;
    });
    expect(input().session.text).toBe("second edit");
    expect(header().dirty).toBe(true);
    await act(async () => {
      await header().save();
    });
    expect(api.saveExplorerFile).toHaveBeenLastCalledWith(
      summary.id,
      {
        content: "second edit",
        path: "source.ts",
        version: "version-two",
      },
      {
        workerId: summary.activeWorkerId,
        projectId: summary.projectId,
        worktreeId: summary.worktreeId,
      },
    );
    expect(header().dirty).toBe(false);
  });
  it("keeps reverted text visibly dirty and retryable after an uncertain save", async () => {
    await render();
    await edit("submitted draft");
    let fail!: (error: Error) => void;
    api.saveExplorerFile.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = header().save();
    });
    await edit("original\n");
    await act(async () => {
      fail(new Error("acknowledgement lost"));
      expect(await pending).toBe(false);
    });
    await settle();
    expect(input().session.dirty).toBe(true);
    expect(header().dirty).toBe(true);
    expect((state.lifecycle as ExplorerLifecycleActions).dirty).toBe(true);
    await act(async () => {
      expect(await header().save()).toBe(true);
    });
    expect(api.saveExplorerFile).toHaveBeenCalledTimes(2);
    expect(api.saveExplorerFile).toHaveBeenLastCalledWith(
      summary.id,
      { content: "original\n", path: "source.ts", version: "version-one" },
      {
        workerId: summary.activeWorkerId,
        projectId: summary.projectId,
        worktreeId: summary.worktreeId,
      },
    );
    expect(header().dirty).toBe(false);
  });
  it("keeps a dirty draft when a fresh server snapshot arrives", async () => {
    await render();
    await edit("private draft");
    const document = input().session;
    await act(async () => {
      client.setQueryData(
        [
          "explorer-file",
          summary.id,
          summary.selectedPath,
          JSON.stringify([
            state.owner,
            summary.activeWorkerId,
            summary.worktreeId,
          ]),
        ],
        {
          path: summary.selectedPath,
          content: "external",
          version: "external-version",
          markdown: false,
        },
      );
    });
    expect(input().session).toBe(document);
    expect(document.text).toBe("private draft");
    expect(document.version).toBe("version-one");
  });
  it("isolates worktrees while retaining the original draft for returning to its source", async () => {
    await render();
    await edit("original checkout draft");
    const original = input().session;
    state.content = "other checkout\n";
    const other = {
      ...summary,
      worktreeId: "worktree-two",
      activeWorkerId: "worker-two",
    };
    await render(other);
    expect(input().session.id).not.toBe(original.id);
    expect(input().session.text).toBe(state.content);
    expect(api.saveExplorerFile).not.toHaveBeenCalled();
    expect((state.lifecycle as ExplorerLifecycleActions).dirty).toBe(true);
    state.content = "original\n";
    await render(summary);
    expect(input().session).toBe(original);
    expect(original.text).toBe("original checkout draft");
  });
  it("does not reuse another account's cached plaintext document", async () => {
    await render();
    await edit("owner-one secret draft");
    const original = input().session;
    state.owner = "owner-two";
    state.content = "owner-two file\n";
    await render();
    expect(input().session.id).not.toBe(original.id);
    expect(input().session.text).toBe("owner-two file\n");
    expect(header().dirty).toBe(false);
    expect((state.lifecycle as ExplorerLifecycleActions).dirty).toBe(false);
  });
});
