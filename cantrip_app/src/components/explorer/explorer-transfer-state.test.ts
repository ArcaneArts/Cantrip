import { describe, expect, it } from "vitest";
import {
  EditorSessionStore,
  editorDocumentId,
} from "@/components/editor/document-session";
import {
  decodeExplorerTransfer,
  encodeExplorerTransfer,
  validateExplorerTransfer,
} from "./explorer-transfer-state";
import type { ExplorerTransferState } from "./explorer-view";
import { JAVA_NBT } from "@cantrip/nbt";

const scope = {
  serverId: "server",
  ownerId: "owner",
  projectId: "project",
  explorerId: "explorer",
  workerId: "worker",
  worktreeId: "worktree",
};
async function fixture(): Promise<ExplorerTransferState> {
  const store = new EditorSessionStore();
  store.resetScope(JSON.stringify([scope.serverId, scope.ownerId]));
  for (const worktree of [scope.worktreeId, "inactive-worktree"]) {
    const document = store.open(
      editorDocumentId({
        server: scope.serverId,
        account: scope.ownerId,
        project: scope.projectId,
        worker: scope.workerId,
        worktree,
        path: "source.ts",
      }),
      "original\r\n",
      "v1",
    );
    document.editExternal("unsaved draft\n");
  }
  return {
    explorerId: scope.explorerId,
    projectId: scope.projectId,
    workerId: scope.workerId,
    worktreeId: scope.worktreeId,
    selectedPath: "source.ts",
    fileMode: "edit",
    documents: await store.captureTransfer(),
  };
}

describe("editor transfer decoding", () => {
  it("carries sparse NBT view state only in the scoped private transfer and rejects malformed positions", async () => {
    const state = await fixture();
    state.viewerState = {
      viewer: "nbt",
      version: 1,
      baselineVersion: "v1",
      format: { ...JAVA_NBT },
      profile: "java",
      compression: "none",
      expanded: ["node:0"],
      selected: "node:1",
      target: null,
      mode: "tree",
      editing: true,
      findOpen: false,
      tree: { position: 123.5, rank: 124 },
    };
    const restored = decodeExplorerTransfer(
      encodeExplorerTransfer(state, scope),
      scope,
    );
    expect(restored.viewerState).toEqual(state.viewerState);
    expect(restored.viewerState).not.toBe(state.viewerState);
    state.viewerState.tree.position = NaN;
    expect(() => validateExplorerTransfer(state, scope)).toThrow(/NBT view/);
  });
  it("binds document transfers to the document ID and exact file", async () => {
    const original = await fixture();
    const documentScope = {
      ...scope,
      documentId: "document-one",
      documentPath: "source.ts",
    };
    original.documentId = documentScope.documentId;
    original.documents.documents = original.documents.documents.slice(0, 1);
    const bytes = encodeExplorerTransfer(original, documentScope);
    expect(decodeExplorerTransfer(bytes, documentScope)).toEqual(original);
    expect(() =>
      decodeExplorerTransfer(bytes, {
        ...documentScope,
        documentId: "document-two",
      }),
    ).toThrow(/mismatched/);
    expect(() =>
      decodeExplorerTransfer(bytes, {
        ...documentScope,
        documentPath: "other.ts",
      }),
    ).toThrow(/mismatched/);
    expect(() => decodeExplorerTransfer(bytes, scope)).toThrow(/mismatched/);
    const foreign = await fixture();
    foreign.documentId = documentScope.documentId;
    expect(() => validateExplorerTransfer(foreign, documentScope)).toThrow(
      /mismatched/,
    );
  });
  it("round-trips selected and inactive documents with independent validated objects", async () => {
    const original = await fixture();
    const decoded = decodeExplorerTransfer(
      encodeExplorerTransfer(original, scope),
      scope,
    );
    expect(decoded).toEqual(original);
    expect(decoded.documents.documents).not.toBe(original.documents.documents);
    const destination = new EditorSessionStore();
    destination.resetScope(original.documents.scope!);
    destination.restoreTransfer(decoded.documents);
    expect(destination.hasDirtyDocuments).toBe(true);
    expect(destination.get(decoded.documents.documents[1]!.id)?.text).toBe(
      "unsaved draft\n",
    );
  });

  it.each([
    "serverId",
    "ownerId",
    "projectId",
    "explorerId",
    "workerId",
    "worktreeId",
  ] as const)("rejects a different %s", async (field) => {
    const bytes = encodeExplorerTransfer(await fixture(), scope);
    expect(() =>
      decodeExplorerTransfer(bytes, { ...scope, [field]: "different" }),
    ).toThrow(/mismatched/);
  });

  it.each([
    (state: ExplorerTransferState) => {
      state.documents.documents.push(state.documents.documents[0]!);
    },
    (state: ExplorerTransferState) => {
      state.documents.documents[0]!.revision = -1;
    },
    (state: ExplorerTransferState) => {
      state.documents.documents[0]!.scrollTop = NaN;
    },
    (state: ExplorerTransferState) => {
      state.documents.documents[0]!.selection = {
        start: 10,
        end: 1,
        direction: "none",
      };
    },
    (state: ExplorerTransferState) => {
      state.documents.documents[0]!.history.undo[0]!.inverse.from = -1;
    },
    (state: ExplorerTransferState) => {
      state.documents.documents[0]!.id = JSON.stringify([
        "server",
        "foreign-owner",
        "worker",
        "project",
        "worktree",
        "secret",
      ]);
    },
  ])(
    "rejects malformed document batches without changing source state",
    async (corrupt) => {
      const state = await fixture();
      corrupt(state);
      const before = structuredClone(state);
      expect(() => validateExplorerTransfer(state, scope)).toThrow(
        /Invalid or mismatched/,
      );
      expect(state).toEqual(before);
    },
  );

  it("rejects malformed UTF-8, JSON and unsupported versions with content-free errors", () => {
    for (const bytes of [
      new Uint8Array([255]),
      new TextEncoder().encode("private malformed draft"),
      new TextEncoder().encode('{"version":2}'),
    ]) {
      expect(() => decodeExplorerTransfer(bytes, scope)).toThrow(
        "Invalid or mismatched editor transfer state.",
      );
    }
  });
});
