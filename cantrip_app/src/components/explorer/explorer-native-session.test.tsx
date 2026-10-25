// @vitest-environment jsdom
import type { ExplorerSummary } from "@cantrip/protocol";
import type { EditorDocumentSession } from "@/components/editor/document-session";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, StrictMode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  publishHeader: true,
  strict: false,
  ready: true,
  owner: "owner-one",
  content: "original\n",
  header: null as unknown,
  lifecycle: null as unknown,
  input: null as unknown,
  transientPath: undefined as string | undefined,
  fileAccess: undefined as import("@/lib/file-access").FileAccess | undefined,
  recovery: undefined as
    import("./use-file-document-recovery").FileDocumentRecovery | undefined,
  initialTransfer: undefined as
    import("./explorer-view").ExplorerTransferState | undefined,
  staging: undefined as
    import("./explorer-view").ExplorerTransferStaging | undefined,
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
  readOnly?: boolean;
  active?: boolean;
  session: EditorDocumentSession;
  path: string;
  onReady?(session: EditorDocumentSession): void;
  onChange(text: string): void;
  onViewStateChange?(): void;
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
  type FileDocumentEditorView,
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
function tree(explorer: ExplorerSummary | FileDocumentEditorView = summary) {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(ExplorerView, {
      appearance: "dark",
      explorer,
      fileAccess: state.fileAccess,
      documentRecovery: state.recovery,
      initialTransfer: state.initialTransfer,
      transferStaging: state.staging,
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
async function render(
  explorer: ExplorerSummary | FileDocumentEditorView = summary,
) {
  await act(async () => {
    const content = state.strict
      ? createElement(StrictMode, null, tree(explorer))
      : tree(explorer);
    if (renderer) renderer.update(content);
    else renderer = TestRenderer.create(content);
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
  state.strict = false;
  state.ready = true;
  state.owner = "owner-one";
  state.content = "original\n";
  state.input = null;
  state.header = null;
  state.lifecycle = null;
  state.transientPath = undefined;
  state.fileAccess = undefined;
  state.recovery = undefined;
  state.initialTransfer = undefined;
  state.staging = undefined;
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
  it("holds approved close input inert until cancellation without discarding its draft", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      await render();
      await edit("close-approved draft");
      const actions = state.lifecycle as ExplorerLifecycleActions;
      await act(async () => {
        await actions.prepareClose();
      });
      expect(input().readOnly).toBe(true);
      expect(input().session.text).toBe("close-approved draft");
      await act(async () => input().onChange("late input"));
      expect(input().session.text).toBe("close-approved draft");
      await act(async () => actions.cancelClose());
      expect(input().readOnly).toBe(false);
      expect(input().session.text).toBe("close-approved draft");
      await edit("editing resumed");
      expect(input().session.text).toBe("editing resumed");
    } finally {
      confirm.mockRestore();
    }
  });
  it("checkpoints edits and viewport state, and awaits recovery before transfer capture completes", async () => {
    const checkpoint = vi.fn(
      async (_snapshot: import("./explorer-view").ExplorerTransferState) => {},
    );
    state.recovery = { checkpoint, closeCommitted: vi.fn(async () => {}) };
    await render();
    await edit("recovery draft");
    expect(checkpoint.mock.lastCall![0].documents.documents[0]!.text).toBe(
      "recovery draft",
    );
    await act(async () => {
      input().session.selection = { start: 1, end: 4, direction: "forward" };
      input().session.scrollTop = 240;
      input().onViewStateChange!();
    });
    expect(checkpoint.mock.lastCall![0].documents.documents[0]).toMatchObject({
      selection: { start: 1, end: 4, direction: "forward" },
      scrollTop: 240,
    });
    const failure = new Error("recovery storage failed");
    checkpoint.mockRejectedValueOnce(failure);
    await expect(
      (state.lifecycle as ExplorerLifecycleActions).captureTransfer!(),
    ).rejects.toBe(failure);
    expect(input().session.text).toBe("recovery draft");
  });

  it("renders a document view without an Explorer entity or Explorer mode writes", async () => {
    const setMode = vi.fn(async (_mode: string) => {});
    const view: FileDocumentEditorView = {
      kind: "file-document",
      id: "tab-one",
      documentId: "document-one",
      projectId: "project-one",
      worktreeId: "worktree-one",
      activeWorkerId: "worker-one",
      selectedPath: "source.ts",
      title: "source.ts",
      fileMode: "edit",
      setMode,
      openFile: vi.fn(),
    };
    state.fileAccess = {
      cacheKey: "file-document:document-one",
      read: vi.fn().mockResolvedValue({
        path: "source.ts",
        content: "document",
        version: "v1",
        markdown: false,
        size: 8,
      }),
      save: vi.fn(),
      media: vi.fn(),
    };
    api.updateExplorerViewState.mockClear();
    await render(view);
    expect(input().session.text).toBe("document");
    expect(header().canGoBack).toBe(false);
    expect(header().showFileClose).toBe(false);
    await act(async () => {
      header().setFileMode("preview");
    });
    expect(setMode).toHaveBeenCalledWith("preview");
    expect(api.updateExplorerViewState).not.toHaveBeenCalled();
    const transfer = await (state.lifecycle as ExplorerLifecycleActions)
      .captureTransfer!();
    expect(transfer).toMatchObject({
      explorerId: "tab-one",
      documentId: "document-one",
      selectedPath: "source.ts",
    });
    expect(api.getExplorerFile).not.toHaveBeenCalled();
    setMode.mockRejectedValueOnce(new Error("Mode write failed"));
    await act(async () => {
      header().setFileMode("edit");
    });
    expect(
      await (state.lifecycle as ExplorerLifecycleActions).flushViewState!(),
    ).toBe(false);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Mode write failed");
    expect(api.updateExplorerViewState).not.toHaveBeenCalled();
  });
  it("uses document file access for reads and versioned saves without Explorer I/O", async () => {
    const read = vi.fn().mockResolvedValue({
      path: "source.ts",
      content: "document content",
      version: "version-one",
      markdown: false,
      size: 16,
    });
    const save = vi.fn().mockImplementation(async (value) => ({
      ...value,
      version: "version-two",
      markdown: false,
      size: value.content.length,
    }));
    state.fileAccess = {
      cacheKey: "file-document:document-one",
      read,
      save,
      media: vi.fn(),
    };
    await render();
    expect(input().session.text).toBe("document content");
    await edit("document draft");
    await act(async () => {
      await header().save();
    });
    expect(save).toHaveBeenCalledWith({
      path: "source.ts",
      content: "document draft",
      version: "version-one",
    });
    expect(header().dirty).toBe(false);
    expect(api.getExplorerFile).not.toHaveBeenCalled();
    expect(api.saveExplorerFile).not.toHaveBeenCalled();
  });
  it.each(["back", "refresh"] as const)(
    "performs %s after async approval for the unchanged revision",
    async (action) => {
      const confirm = vi
        .spyOn(window, "confirm")
        .mockImplementation((() =>
          Promise.resolve(true)) as unknown as typeof window.confirm);
      try {
        await render();
        await edit("approved discard");
        await act(async () => {
          await header()[action]();
        });
        await settle();
        expect(confirm).toHaveBeenCalledOnce();
        expect(header().selectedPath).toBe(
          action === "back" ? null : "source.ts",
        );
        expect(header().dirty).toBe(false);
        if (action === "refresh")
          expect(input().session.text).toBe("original\n");
      } finally {
        confirm.mockRestore();
      }
    },
  );
  it("retains the approved draft when the replacement read fails", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      await render();
      await edit("retain me if reading fails");
      const document = input().session;
      api.getExplorerFile.mockRejectedValueOnce(
        new Error("worker unavailable"),
      );
      await act(async () => {
        await expect(header().refresh()).rejects.toThrow("worker unavailable");
      });
      expect(document.text).toBe("retain me if reading fails");
      expect(document.dirty).toBe(true);
      const snapshot = await (state.lifecycle as ExplorerLifecycleActions)
        .captureTransfer!();
      expect(snapshot.documents.documents[0]!.text).toBe(
        "retain me if reading fails",
      );
    } finally {
      confirm.mockRestore();
    }
  });

  it("does not discard edits made after approval while the replacement file is loading", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      await render();
      await edit("approved draft");
      let finish!: (value: unknown) => void;
      api.getExplorerFile.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      let pending!: Promise<unknown>;
      await act(async () => {
        pending = Promise.resolve(header().refresh());
      });
      await edit("new edit during read");
      await act(async () => {
        finish({
          path: "source.ts",
          content: "replacement",
          version: "fresh",
          markdown: false,
        });
        await expect(pending).rejects.toThrow(
          "document changed while reloading",
        );
      });
      expect(input().session.text).toBe("new edit during read");
      expect(input().session.dirty).toBe(true);
    } finally {
      confirm.mockRestore();
    }
  });
  it.each(["back", "refresh"] as const)(
    "awaits %s confirmation and rejects approval for a newer draft",
    async (action) => {
      let answer!: (value: boolean) => void;
      const confirm = vi.spyOn(window, "confirm").mockImplementation(
        (() =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          })) as unknown as typeof window.confirm,
      );
      try {
        await render();
        await edit("first draft");
        const document = input().session;
        let pending!: Promise<unknown>;
        await act(async () => {
          pending = Promise.resolve(header()[action]());
        });
        expect(document.text).toBe("first draft");
        await edit("newer draft while dialog is open");
        await act(async () => {
          answer(true);
          await pending;
        });
        expect(input().session).toBe(document);
        expect(document.text).toBe("newer draft while dialog is open");
        expect(document.dirty).toBe(true);
        expect(header().selectedPath).toBe("source.ts");
        confirm.mockImplementation((() =>
          Promise.resolve(false)) as unknown as typeof window.confirm);
        await act(async () => {
          await header()[action]();
        });
        expect(document.dirty).toBe(true);
        expect(header().selectedPath).toBe("source.ts");
        confirm.mockImplementation((() =>
          Promise.reject(
            new Error("native dialog failed"),
          )) as unknown as typeof window.confirm);
        await act(async () => {
          await header()[action]();
        });
        expect(document.text).toBe("newer draft while dialog is open");
        expect(header().selectedPath).toBe("source.ts");
      } finally {
        confirm.mockRestore();
      }
    },
  );
  it("awaits native async close confirmation and preserves drafts when the dialog rejects", async () => {
    let answer!: (approved: boolean) => void;
    const confirm = vi.spyOn(window, "confirm").mockImplementation(
      // Tauri's dialog plugin overrides the DOM signature with an async call.
      (() =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        })) as unknown as typeof window.confirm,
    );
    try {
      await render();
      await edit("native pending confirmation");
      const lifecycle = state.lifecycle as ExplorerLifecycleActions;
      let settled = false;
      const close = lifecycle.prepareClose();
      void close.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.resolve();
      expect(settled).toBe(false);
      answer(false);
      await expect(close).rejects.toThrow(/close canceled/);
      expect(input().session.text).toBe("native pending confirmation");
      confirm.mockImplementation((() =>
        Promise.reject(
          new Error("dialog unavailable"),
        )) as unknown as typeof window.confirm);
      await expect(lifecycle.prepareClose()).rejects.toThrow(
        "dialog unavailable",
      );
      expect(input().session.dirty).toBe(true);
      confirm.mockImplementation((() =>
        Promise.resolve(true)) as unknown as typeof window.confirm);
      await expect(lifecycle.prepareClose()).resolves.toBeUndefined();
      expect(input().session.text).toBe("native pending confirmation");
    } finally {
      confirm.mockRestore();
    }
  });
  it("closes a clean view without asking about unsaved changes", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      await render();
      await (state.lifecycle as ExplorerLifecycleActions).prepareClose();
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      confirm.mockRestore();
    }
  });

  it("rejects close approval after a newer edit while the native dialog is open", async () => {
    let answer!: (approved: boolean) => void;
    const confirm = vi.spyOn(window, "confirm").mockImplementation(
      (() =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        })) as unknown as typeof window.confirm,
    );
    try {
      await render();
      await edit("original draft");
      const pending = (
        state.lifecycle as ExplorerLifecycleActions
      ).prepareClose();
      await edit("newer draft");
      answer(true);
      await expect(pending).rejects.toThrow(/changed while confirming close/);
      expect(input().session.text).toBe("newer draft");
      expect(input().session.dirty).toBe(true);
    } finally {
      confirm.mockRestore();
    }
  });

  it("preserves dirty buffers on canceled and subsequently failed closes", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      await render();
      await edit("unsaved close regression");
      const lifecycle = state.lifecycle as ExplorerLifecycleActions;
      const before = await lifecycle.captureTransfer!();
      await expect(lifecycle.prepareClose()).rejects.toThrow(/close canceled/);
      expect(await lifecycle.captureTransfer!()).toEqual(before);
      confirm.mockReturnValue(true);
      await lifecycle.prepareClose();
      lifecycle.cancelClose();
      expect(await lifecycle.captureTransfer!()).toEqual(before);
      expect(input().session.dirty).toBe(true);
      expect(api.saveExplorerFile).not.toHaveBeenCalled();
      expect(confirm).toHaveBeenCalledTimes(2);
    } finally {
      confirm.mockRestore();
    }
  });

  it("acknowledges a restored file browser without waiting for a nonexistent editor", async () => {
    const browser = { ...summary, selectedPath: null };
    await render(browser);
    const snapshot = await (state.lifecycle as ExplorerLifecycleActions)
      .captureTransfer!();
    await act(async () => renderer!.unmount());
    renderer = null;
    state.initialTransfer = snapshot;
    state.staging = { onRestored: vi.fn(), onError: vi.fn() };
    await render(browser);
    expect(state.staging.onRestored).toHaveBeenCalledOnce();
    expect(state.staging.onError).not.toHaveBeenCalled();
    expect(
      renderer!.root.findByProps({ "data-slot": "explorer-view" }).props.inert,
    ).toBe(true);
  });

  it("keeps a staged draft inert until commit and acknowledges actual editor restoration", async () => {
    await render();
    await edit("staged unsaved text");
    const snapshot = await (state.lifecycle as ExplorerLifecycleActions)
      .captureTransfer!();
    await act(async () => renderer!.unmount());
    renderer = null;
    state.initialTransfer = snapshot;
    const staging = { onRestored: vi.fn(), onError: vi.fn() };
    state.staging = staging;
    await render();
    const document = input().session;
    expect(document.text).toBe("staged unsaved text");
    expect(input().readOnly).toBe(true);
    expect(input().active).toBe(false);
    expect(await header().save()).toBe(false);
    expect(staging.onRestored).not.toHaveBeenCalled();
    await act(async () => input().onReady!(document));
    expect(staging.onRestored).toHaveBeenCalledOnce();
    expect(staging.onError).not.toHaveBeenCalled();
    expect(api.saveExplorerFile).not.toHaveBeenCalled();
    state.staging = undefined;
    await render();
    expect(input().session).toBe(document);
    expect(input().readOnly).toBe(false);
    await edit("committed edit");
    expect(document.text).toBe("committed edit");
  });

  it("initializes a destination with its unsaved snapshot before exposing the editor", async () => {
    await render();
    await edit("transferred draft");
    const snapshot = await (state.lifecycle as ExplorerLifecycleActions)
      .captureTransfer!();
    await act(async () => renderer!.unmount());
    renderer = null;
    state.input = null;
    state.initialTransfer = snapshot;
    state.strict = true;
    await render();
    expect(input().session.text).toBe("transferred draft");
    expect(header().dirty).toBe(true);
    expect(api.saveExplorerFile).not.toHaveBeenCalled();
    await edit("destination edit");
    await render();
    expect(input().session.text).toBe("destination edit");
  });

  it("keeps an invalid initial transfer inert instead of opening a different document", async () => {
    await render();
    const snapshot = await (state.lifecycle as ExplorerLifecycleActions)
      .captureTransfer!();
    await act(async () => renderer!.unmount());
    renderer = null;
    state.input = null;
    state.initialTransfer = { ...snapshot, worktreeId: "other-worktree" };
    state.staging = { onRestored: vi.fn(), onError: vi.fn() };
    await render();
    expect(state.staging.onRestored).not.toHaveBeenCalled();
    expect(state.staging.onError).toHaveBeenCalledWith(expect.any(Error));
    expect(state.input).toBeNull();
    expect(
      renderer!.root.findByProps({ "data-slot": "explorer-view" }).props.inert,
    ).toBe(true);
    expect(
      renderer!.root.findByProps({ role: "alert" }).children.join(""),
    ).toMatch(/resource scope/);
    expect(await header().save()).toBe(false);
  });

  it("suspends input and retained header actions without saving, then resumes the same dirty draft", async () => {
    await render();
    await edit("unsaved source");
    const staleInput = input();
    const staleHeader = header();
    const lifecycle = state.lifecycle as ExplorerLifecycleActions;
    let resume!: () => void;
    await act(async () => {
      resume = lifecycle.suspendTransfer!();
    });
    expect(input().readOnly).toBe(true);
    expect(input().active).toBe(false);
    expect(() => lifecycle.suspendTransfer!()).toThrow(/already transferring/);
    await act(async () => {
      staleInput.onChange("late event");
      staleHeader.setFileMode("preview");
      staleHeader.back();
      expect(await staleHeader.save()).toBe(false);
      lifecycle.discard!();
    });
    const snapshot = await lifecycle.captureTransfer!();
    expect(snapshot.documents.documents[0]?.text).toBe("unsaved source");
    expect(snapshot.fileMode).toBe("edit");
    expect(snapshot.selectedPath).toBe("source.ts");
    expect(api.saveExplorerFile).not.toHaveBeenCalled();
    await act(async () => {
      resume();
      resume();
    });
    expect(input().readOnly).toBe(false);
    expect(input().active).toBe(true);
    await edit("resumed source");
    expect(input().session.text).toBe("resumed source");
    expect(header().dirty).toBe(true);
  });

  it("does not reconcile a new file over a suspended draft", async () => {
    await render();
    await edit("keep this draft");
    const lifecycle = state.lifecycle as ExplorerLifecycleActions;
    let resume!: () => void;
    await act(async () => {
      resume = lifecycle.suspendTransfer!();
    });
    await act(async () => {
      await lifecycle.reconcile({ ...summary, selectedPath: "another.ts" });
    });
    expect((await lifecycle.captureTransfer!()).selectedPath).toBe("source.ts");
    expect(input().session.text).toBe("keep this draft");
    await act(async () => resume());
  });

  it("retires rendered content and reattaches the same dirty session after cancellation", async () => {
    await render();
    await edit("unsaved retirement");
    const document = input().session;
    document.selection = { start: 1, end: 4, direction: "forward" };
    document.scrollTop = 71;
    const lifecycle = state.lifecycle as ExplorerLifecycleActions;
    expect(() => lifecycle.retireTransfer!()).toThrow(/suspended/);
    let resume!: () => void;
    await act(async () => {
      resume = lifecycle.suspendTransfer!();
    });
    const before = await lifecycle.captureTransfer!();
    await act(async () => {
      lifecycle.retireTransfer!();
    });
    expect(renderer!.root.findAllByType("textarea")).toHaveLength(0);
    expect(await lifecycle.captureTransfer!()).toEqual(before);
    expect(await header().save()).toBe(false);
    await act(async () => resume());
    expect(renderer!.root.findAllByType("textarea")).toHaveLength(1);
    expect(input().session).toBe(document);
    expect(input().session.text).toBe("unsaved retirement");
    expect(input().session.selection).toEqual({
      start: 1,
      end: 4,
      direction: "forward",
    });
    expect(input().session.scrollTop).toBe(71);
    expect(api.saveExplorerFile).not.toHaveBeenCalled();
  });

  it("restores a captured dirty editor into a fresh renderer without saving", async () => {
    await render();
    await edit("private unsaved transfer");
    input().session.selection = { start: 2, end: 6, direction: "backward" };
    input().session.scrollTop = 93;
    const source = input().session;
    const transfer = await (state.lifecycle as ExplorerLifecycleActions)
      .captureTransfer!();
    await act(async () => renderer!.unmount());
    renderer = null;
    await render();
    expect(input().session.text).toBe("original\n");
    await act(async () =>
      (state.lifecycle as ExplorerLifecycleActions).restoreTransfer!(transfer),
    );
    expect(input().session).not.toBe(source);
    expect(input().session.text).toBe("private unsaved transfer");
    expect(input().session.selection).toEqual(source.selection);
    expect(input().session.scrollTop).toBe(93);
    expect(header().dirty).toBe(true);
    expect(api.saveExplorerFile).not.toHaveBeenCalled();
    expect(source.text).toBe("private unsaved transfer");
  });

  it("rejects transfer to a different checkout without changing its editor", async () => {
    await render();
    await edit("source draft");
    const transfer = await (state.lifecycle as ExplorerLifecycleActions)
      .captureTransfer!();
    await render({ ...summary, worktreeId: "other-worktree" });
    const destination = input().session;
    expect(() =>
      (state.lifecycle as ExplorerLifecycleActions).restoreTransfer!(transfer),
    ).toThrow(/resource scope/);
    expect(input().session).toBe(destination);
    expect(destination.text).toBe("original\n");
    expect(api.saveExplorerFile).not.toHaveBeenCalled();
  });

  it("rejects retained lifecycle callbacks immediately after the signed-in account changes", async () => {
    await render();
    await edit("private source draft");
    const lifecycle = state.lifecycle as ExplorerLifecycleActions;
    const transfer = await lifecycle.captureTransfer!();
    state.owner = "other-owner";
    // Deliberately do not render: session events may precede React cleanup.
    await expect(lifecycle.captureTransfer!()).rejects.toThrow(
      /account changed/,
    );
    expect(() => lifecycle.restoreTransfer!(transfer)).toThrow(/account scope/);
    expect(api.saveExplorerFile).not.toHaveBeenCalled();
  });

  it("fences retained transfer callbacks after the resource changes", async () => {
    await render();
    const stale = state.lifecycle as ExplorerLifecycleActions;
    const transfer = await stale.captureTransfer!();
    await render({ ...summary, worktreeId: "other-worktree" });
    const current = input().session;
    await expect(stale.captureTransfer!()).rejects.toThrow(/resource changed/);
    expect(() => stale.restoreTransfer!(transfer)).toThrow(/resource changed/);
    expect(() => stale.suspendTransfer!()).toThrow(/resource changed/);
    expect(input().session).toBe(current);
    expect(input().readOnly).toBe(false);
    // Returning to the same resource does not revive an old attachment callback.
    await render(summary);
    await expect(stale.captureTransfer!()).rejects.toThrow(/resource changed/);
    expect(
      (await (state.lifecycle as ExplorerLifecycleActions).captureTransfer!())
        .worktreeId,
    ).toBe(summary.worktreeId);
  });

  it("fences retained transfer callbacks after unmount", async () => {
    await render();
    const stale = state.lifecycle as ExplorerLifecycleActions;
    const transfer = await stale.captureTransfer!();
    await act(async () => renderer!.unmount());
    renderer = null;
    await expect(stale.captureTransfer!()).rejects.toThrow(/resource changed/);
    expect(() => stale.restoreTransfer!(transfer)).toThrow(/resource changed/);
    expect(() => stale.suspendTransfer!()).toThrow(/resource changed/);
  });

  it("validates every transferred document before replacing the rendered document", async () => {
    await render();
    const lifecycle = state.lifecycle as ExplorerLifecycleActions;
    const transfer = await lifecycle.captureTransfer!();
    const original = input().session;
    transfer.documents.documents[0]!.history.undo = [
      {
        change: { from: -1, to: 1, insert: "private text" },
        inverse: { from: 0, to: 1, insert: "original" },
        before: { start: 0, end: 0, direction: "none" },
        after: { start: 0, end: 0, direction: "none" },
      },
    ];
    expect(() => lifecycle.restoreTransfer!(transfer)).toThrow(
      "Invalid or mismatched editor transfer state.",
    );
    expect(input().session).toBe(original);
    expect(original.text).toBe("original\n");
    expect(api.saveExplorerFile).not.toHaveBeenCalled();
  });

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
