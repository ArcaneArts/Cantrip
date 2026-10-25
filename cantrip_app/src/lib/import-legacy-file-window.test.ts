import { beforeEach, expect, it, vi } from "vitest";
import {
  importWorkspaceLegacyFiles,
  type WorkspaceOwnership,
} from "@cantrip/protocol";
import {
  EditorSessionStore,
  editorDocumentId,
} from "@/components/editor/document-session";
import type {
  ExplorerLifecycleActions,
  ExplorerTransferState,
} from "@/components/explorer/explorer-view";
import { createLegacyFileWindowImporter } from "./import-legacy-file-window";

const io = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  events: [] as string[],
  read: vi.fn(),
  seed: vi.fn(),
  importFiles: vi.fn(),
  failCheckpoint: false,
  current: true,
}));
vi.mock("./client-session", () => ({
  getClientSessionIdentitySnapshot: () => ({
    serverId: "server",
    userId: "owner",
  }),
  clientSessionIdentityMatches: () => io.current,
}));
vi.mock("./workspace-device-identity", () => ({
  readWorkspaceDeviceIdentity: async () => ({
    workspaceId: "workspace",
    mainWindowId: "main",
  }),
}));
vi.mock("./workspace-renderer-lifetime", () => ({
  workspaceRendererLifetime: async () => ({
    releaseConnection: () => io.events.push("release"),
  }),
}));
vi.mock("./desktop-popout", () => ({
  currentDesktopWorkspaceWindowId: async () => "cantrip-editor-old",
  desktopPopoutPaneSearch: (value: unknown) => JSON.stringify(value),
}));
vi.mock("./api/workspace-layouts", () => ({
  workspaceLayoutTransport: () => ({
    read: io.read,
    seed: io.seed,
    importLegacyFiles: io.importFiles,
  }),
}));
vi.mock("./api/file-documents", () => ({
  getFileDocuments: async () => [],
  createFileDocument: async (value: unknown) => value,
}));
vi.mock("./surface-title-encryption", () => ({
  surfaceTitleEncryption: {
    fileDocumentId: ({ path }: { path: string }) => `doc:${path}`,
  },
}));
vi.mock("./document-recovery-session", () => ({
  DocumentRecoverySession: class {
    key: string;
    constructor(value: { tabId: string; documentId: string }) {
      this.key = `${value.tabId}/${value.documentId}`;
    }
    async load(decode: (value: Uint8Array) => unknown) {
      const value = io.records.get(this.key);
      return value
        ? decode(new TextEncoder().encode(JSON.stringify(value)))
        : null;
    }
    async checkpoint(bytes: Uint8Array | null) {
      if (io.failCheckpoint) throw new Error("checkpoint failed");
      io.events.push(`checkpoint:${this.key}`);
      io.records.set(
        this.key,
        bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null,
      );
    }
    dispose() {}
  },
}));
let layout: WorkspaceOwnership;
beforeEach(() => {
  vi.clearAllMocks();
  io.records.clear();
  io.events.length = 0;
  io.failCheckpoint = false;
  io.current = true;
  layout = {
    version: 1,
    id: "workspace",
    projectId: "project",
    revision: 0,
    mainWindowId: "main",
    windows: [
      {
        id: "main",
        attachmentGeneration: 0,
        panes: [],
        centerRoot: null,
        focusedPaneId: null,
        recentPaneIds: [],
      },
    ],
  };
  io.read.mockImplementation(async () => layout);
  io.importFiles.mockImplementation(
    async ({ expectedRevision: _, ...request }) => {
      io.events.push("commit");
      const result = importWorkspaceLegacyFiles(
        layout,
        request,
        new Map(
          request.views.map((view: { documentId: string }) => [
            view.documentId,
            null,
          ]),
        ),
      );
      layout = result.layout;
      return result;
    },
  );
});
function fixture() {
  const importLegacyFileWindow = createLegacyFileWindowImporter();
  const store = new EditorSessionStore();
  store.resetScope(JSON.stringify(["server", "owner"]));
  for (const path of ["first.rs", "inactive.rs"]) {
    store
      .open(
        editorDocumentId({
          server: "server",
          account: "owner",
          worker: "worker",
          project: "project",
          worktree: "tree",
          path,
        }),
        "disk",
        "v1",
      )
      .editExternal(`dirty:${path}`);
  }
  const capture = (): ExplorerTransferState => ({
    explorerId: "explorer",
    projectId: "project",
    workerId: "worker",
    worktreeId: "tree",
    selectedPath: "first.rs",
    fileMode: "edit",
    documents: store.captureRecovery(),
  });
  const lifecycle: ExplorerLifecycleActions = {
    dirty: true,
    cancelClose() {},
    prepareClose: async () => {},
    reconcile: async () => {},
    save: async () => true,
    flushViewState: async () => true,
    suspendTransfer: () => {
      io.events.push("suspend");
      return () => {
        io.events.push("resume");
      };
    },
    captureTransfer: async () => capture(),
    restoreTransfer: (state) => store.restoreTransfer(state.documents),
    retireTransfer: () => {
      io.events.push("retire");
    },
  };
  const activate = vi.fn(() => {
    io.events.push("activate");
  });
  return {
    capture,
    activate,
    edit: (text: string) =>
      store.get(capture().documents.documents[0]!.id)!.editExternal(text),
    run: () =>
      importLegacyFileWindow({
        projectId: "project",
        explorerId: "explorer",
        path: "first.rs",
        lifecycle,
        activate,
      }),
  };
}
it("checkpoints selected and inactive drafts before importing and activating the same host", async () => {
  const f = fixture();
  await f.run();
  expect(layout.windows[1]!.panes[0]!.tabs).toHaveLength(2);
  expect(layout.windows[1]!.id).toBe("cantrip-editor-old");
  expect(
    io.events.filter((event) => event.startsWith("checkpoint:")),
  ).toHaveLength(4);
  expect(io.events.indexOf("commit")).toBeGreaterThan(
    io.events.lastIndexOf(
      io.events.filter((event) => event.startsWith("checkpoint:")).at(-1)!,
    ),
  );
  expect(io.events.slice(-3)).toEqual(["retire", "activate", "release"]);
  expect(io.events).not.toContain("resume");
  expect(f.activate).toHaveBeenCalledOnce();
});
it("does not commit or retire if protected checkpointing fails", async () => {
  io.failCheckpoint = true;
  await expect(fixture().run()).rejects.toThrow("checkpoint failed");
  expect(io.importFiles).not.toHaveBeenCalled();
  expect(io.events).toContain("resume");
  expect(io.events).not.toContain("retire");
});
it("retries a lost commit response without creating duplicate views", async () => {
  const commit = io.importFiles.getMockImplementation()!;
  io.importFiles.mockImplementationOnce(async (...args) => {
    await commit(...args);
    throw new Error("response lost");
  });
  const f = fixture();
  await expect(f.run()).rejects.toThrow("response lost");
  await f.run();
  expect(layout.revision).toBe(1);
  expect(layout.windows).toHaveLength(2);
  expect(f.activate).toHaveBeenCalledOnce();
});

it("preserves edits made in the same live source after a failed import", async () => {
  io.importFiles.mockRejectedValueOnce(new Error("temporary failure"));
  const f = fixture();
  await expect(f.run()).rejects.toThrow("temporary failure");
  f.edit("newer live draft");
  await f.run();
  expect(layout.windows).toHaveLength(2);
  const checkpoint = [...io.records.entries()].find(([key]) =>
    key.endsWith("/doc:first.rs"),
  )![1] as ExplorerTransferState;
  expect(checkpoint.documents.documents[0]!.text).toBe("newer live draft");
});

it("requires reconciliation when a new source diverges from recovered dirty data", async () => {
  io.importFiles.mockRejectedValueOnce(new Error("temporary failure"));
  const original = fixture();
  await expect(original.run()).rejects.toThrow("temporary failure");
  const replacement = fixture();
  replacement.edit("unrelated divergent draft");
  await expect(replacement.run()).rejects.toThrow(
    "Both drafts have been retained",
  );
  expect(layout.windows).toHaveLength(1);
});
it("does not rewrite document checkpoints after an owned renderer attached", async () => {
  const f = fixture();
  await f.run();
  layout.windows[1]!.attachmentGeneration = 1;
  const before = io.events.filter((event) => event.includes("/doc:")).length;
  await expect(f.run()).rejects.toThrow("already imported");
  expect(io.events.filter((event) => event.includes("/doc:")).length).toBe(
    before,
  );
});
it("does not resurrect a closed imported window", async () => {
  const f = fixture();
  await f.run();
  layout.windows.splice(1, 1);
  await expect(f.run()).rejects.toThrow("already imported");
  expect(layout.windows).toHaveLength(1);
});
