import { beforeEach, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  applyWorkspaceCommand,
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
import { WorkspaceCommandClient } from "./workspace-command-client";
import { migrateOwnedLegacyFile } from "./migrate-owned-legacy-file";
import { getExplorerMigrationSource } from "./api/explorers";
import { getFileDocuments, createFileDocument } from "./api/file-documents";

const io = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  events: [] as string[],
  failCheckpoint: false,
}));
vi.mock("./client-session", () => ({
  getClientSessionIdentitySnapshot: () => ({
    serverId: "server",
    userId: "owner",
    accountId: "account",
  }),
  clientSessionIdentityMatches: () => true,
}));
vi.mock("./api/explorers", () => ({ getExplorerMigrationSource: vi.fn() }));
vi.mock("./api/file-documents", () => ({
  getFileDocuments: vi.fn(),
  createFileDocument: vi.fn(),
}));
vi.mock("./surface-title-encryption", () => ({
  surfaceTitleEncryption: {
    fileDocumentId: (binding: { path: string }) => `document:${binding.path}`,
  },
}));
vi.mock("./document-recovery-session", () => ({
  DocumentRecoverySession: class {
    key: string;
    constructor(binding: { documentId: string }) {
      this.key = binding.documentId;
    }
    async load(decode: (bytes: Uint8Array) => unknown) {
      const value = io.records.get(this.key);
      return value
        ? decode(new TextEncoder().encode(JSON.stringify(value)))
        : null;
    }
    async checkpoint(bytes: Uint8Array | null) {
      if (io.failCheckpoint) throw new Error("checkpoint failed");
      io.events.push(`checkpoint:${this.key}:${bytes ? "saved" : "cleared"}`);
      io.records.set(
        this.key,
        bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null,
      );
    }
    dispose() {}
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  io.records.clear();
  io.events.length = 0;
  io.failCheckpoint = false;
  vi.mocked(getFileDocuments).mockResolvedValue([]);
  vi.mocked(createFileDocument).mockImplementation(async (input) => ({
    ...input,
    createdAt: "2026-10-24T00:00:00.000Z",
  }));
  vi.mocked(getExplorerMigrationSource).mockResolvedValue({
    explorer: {
      activeWorkerId: "worker",
      worktreeId: "tree",
      selectedPath: "first.rs",
    },
    wire: {
      stateProtection: {
        classification: { recordKind: "explorer-state" },
        protectedState: {
          formatVersion: 1,
          keyRevision: 1,
          envelope: {
            version: 1,
            algorithm: "AES-256-GCM",
            keyRevision: 1,
            nonce: "A".repeat(16),
            ciphertext: "A".repeat(43),
          },
        },
      },
    },
  } as Awaited<ReturnType<typeof getExplorerMigrationSource>>);
});

function fixture(dirty = true, reject = false) {
  const store = new EditorSessionStore();
  store.resetScope(JSON.stringify(["server", "owner"]));
  for (const path of ["first.rs", "second.rs"]) {
    const document = store.open(
      editorDocumentId({
        server: "server",
        account: "owner",
        worker: "worker",
        project: "project",
        worktree: "tree",
        path,
      }),
      "baseline",
      "v1",
    );
    if (dirty) document.editExternal(`draft:${path}`);
  }
  const capture = (): ExplorerTransferState => ({
    explorerId: "explorer",
    projectId: "project",
    worktreeId: "tree",
    workerId: "worker",
    selectedPath: "first.rs",
    fileMode: "edit",
    documents: store.captureRecovery(),
  });
  const resume = vi.fn(() => {
    io.events.push("resume");
  });
  const lifecycle: ExplorerLifecycleActions = {
    dirty,
    cancelClose() {},
    async flushViewState() {
      return true;
    },
    async prepareClose() {},
    async reconcile() {},
    async save() {
      return true;
    },
    suspendTransfer: () => {
      io.events.push("suspend");
      return resume;
    },
    retireTransfer: () => {
      io.events.push("retire");
    },
    captureTransfer: async () => capture(),
    restoreTransfer: (state) => store.restoreTransfer(state.documents),
  };
  let layout: WorkspaceOwnership = {
    version: 1,
    id: "workspace",
    projectId: "project",
    revision: 0,
    mainWindowId: "main",
    windows: [
      {
        id: "main",
        attachmentGeneration: 0,
        focusedPaneId: "pane",
        recentPaneIds: ["pane"],
        centerRoot: { kind: "pane", paneId: "pane" },
        panes: [
          {
            id: "pane",
            region: "center",
            titleProtection: null,
            activeTabId: "tab",
            tabs: [
              {
                id: "tab",
                resource: {
                  kind: "entity",
                  definitionId: "project.explorer",
                  resourceId: "explorer",
                },
                preview: false,
                builtInState: null,
                titleProtection: null,
                dockPresentation: null,
              },
            ],
          },
        ],
      },
    ],
  };
  const controller = new WorkspaceCommandClient(layout, "main", 0, {
    read: async () => layout,
    classify: () => "rejected",
    execute: async (command) => {
      io.events.push("dispatch");
      if (reject) throw new Error("server rejected");
      const result = applyWorkspaceCommand(layout, command);
      layout = result.layout;
      return { ...result, appliedRevision: layout.revision, replayed: false };
    },
  });
  return {
    capture,
    resume,
    controller,
    run: () =>
      migrateOwnedLegacyFile({
        controller,
        windowId: "main",
        tabId: "tab",
        explorerId: "explorer",
        lifecycle,
        queryClient: new QueryClient(),
      }),
  };
}

it("checkpoints every buffer before committing and never resumes the retired source", async () => {
  const f = fixture();
  await f.run();
  expect(io.events).toEqual([
    "suspend",
    "checkpoint:legacy-migration:explorer:saved",
    "checkpoint:document:first.rs:saved",
    "checkpoint:document:second.rs:saved",
    "retire",
    "dispatch",
    "checkpoint:legacy-migration:explorer:cleared",
  ]);
  expect(f.resume).not.toHaveBeenCalled();
  const tabs =
    f.controller.getSnapshot().authoritative.windows[0]!.panes[0]!.tabs;
  expect(tabs.map((tab) => tab.id)).toEqual([
    "tab",
    "legacy-retained:tab:document:second.rs",
  ]);
  expect(io.records.get("document:second.rs")).toMatchObject({
    documents: { documents: [{ text: "draft:second.rs" }] },
  });
});

it("keeps the source and journal when the server rejects conversion", async () => {
  const f = fixture(true, true);
  await expect(f.run()).rejects.toThrow("server rejected");
  expect(f.resume).toHaveBeenCalledOnce();
  expect(io.records.get("legacy-migration:explorer")).toEqual(f.capture());
  expect(
    f.controller.getSnapshot().authoritative.windows[0]!.panes[0]!.tabs[0]!
      .resource.definitionId,
  ).toBe("project.explorer");
});

it("recovers pre-commit drafts after restart instead of checkpointing clean disk content over them", async () => {
  io.records.set("legacy-migration:explorer", fixture().capture());
  const restarted = fixture(false);
  await restarted.run();
  expect(io.records.get("document:first.rs")).toMatchObject({
    documents: { documents: [{ text: "draft:first.rs" }] },
  });
  expect(io.records.get("document:second.rs")).toMatchObject({
    documents: { documents: [{ text: "draft:second.rs" }] },
  });
});

it("does not change ownership when a durable checkpoint fails", async () => {
  const f = fixture();
  io.failCheckpoint = true;
  await expect(f.run()).rejects.toThrow("checkpoint failed");
  expect(io.events).not.toContain("dispatch");
  expect(f.resume).toHaveBeenCalledOnce();
});

it("retains both conflicting recovered and live drafts without overwriting either", async () => {
  const f = fixture();
  const prior = structuredClone(f.capture());
  prior.documents.documents[0]!.text = "different recovered draft";
  io.records.set("legacy-migration:explorer", prior);
  await expect(f.run()).rejects.toThrow(/conflicts with a live draft/);
  expect(io.records.get("legacy-migration:explorer")).toEqual(prior);
  expect(f.capture().documents.documents[0]!.text).toBe("draft:first.rs");
  expect(io.events).not.toContain("dispatch");
});

it("does not resume a source whose attachment was replaced during migration", async () => {
  const f = fixture();
  vi.mocked(getFileDocuments).mockImplementationOnce(async () => {
    f.controller.dispose(new Error("replaced"));
    return [];
  });
  await expect(f.run()).rejects.toThrow(/ownership changed/);
  expect(f.resume).not.toHaveBeenCalled();
  expect(io.records.get("legacy-migration:explorer")).toBeTruthy();
});
