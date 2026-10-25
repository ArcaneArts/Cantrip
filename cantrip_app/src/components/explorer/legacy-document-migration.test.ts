import { expect, it, vi } from "vitest";
import {
  EditorSessionStore,
  editorDocumentId,
} from "@/components/editor/document-session";
import {
  bindLegacyDocument,
  planLegacyDocuments,
  mergeLegacyDocumentRecovery,
  reconcileLegacyDocumentRecovery,
} from "./legacy-document-migration";
import type { ExplorerTransferState } from "./explorer-view";

const scope = {
  serverId: "server",
  ownerId: "owner",
  projectId: "project",
  explorerId: "explorer",
  workerId: "worker",
  worktreeId: "worktree",
};

it.each(["live", "recovered"] as const)(
  "resolves each conflicting draft using explicit %s choices",
  async (choice) => {
    const live = fixture();
    const recovered = structuredClone(live);
    for (const doc of recovered.documents.documents) doc.text += " recovered";
    const before = structuredClone([live, recovered]);
    const resolve = vi.fn(async () => choice);
    const result = await reconcileLegacyDocumentRecovery(
      live,
      recovered,
      scope,
      resolve,
      () => {},
    );
    expect(result.documents).toEqual(
      (choice === "live" ? live : recovered).documents,
    );
    expect(resolve).toHaveBeenCalledTimes(2);
    expect([live, recovered]).toEqual(before);
  },
);

it("cancels without applying earlier per-file choices or mutating snapshots", async () => {
  const live = fixture();
  const recovered = structuredClone(live);
  for (const doc of recovered.documents.documents) doc.text += " recovered";
  const before = structuredClone([live, recovered]);
  const resolve = vi
    .fn()
    .mockResolvedValueOnce("recovered")
    .mockResolvedValueOnce(null);
  await expect(
    reconcileLegacyDocumentRecovery(live, recovered, scope, resolve, () => {}),
  ).rejects.toThrow("cancelled");
  expect([live, recovered]).toEqual(before);
});

it("rejects ownership changes while the conflict choice is pending", async () => {
  const live = fixture();
  const recovered = structuredClone(live);
  recovered.documents.documents[0]!.version = "new-version";
  let current = true;
  await expect(
    reconcileLegacyDocumentRecovery(
      live,
      recovered,
      scope,
      async () => {
        current = false;
        return "recovered";
      },
      () => {
        if (!current) throw new Error("owner changed");
      },
    ),
  ).rejects.toThrow("owner changed");
});

it("does not prompt or mutate on invalid recovered scope", async () => {
  const live = fixture();
  const resolve = vi.fn();
  await expect(
    reconcileLegacyDocumentRecovery(
      live,
      { ...live, projectId: "foreign" },
      scope,
      resolve,
      () => {},
    ),
  ).rejects.toThrow();
  expect(resolve).not.toHaveBeenCalled();
});

function fixture(): ExplorerTransferState {
  const store = new EditorSessionStore();
  store.resetScope(JSON.stringify([scope.serverId, scope.ownerId]));
  for (const worktree of ["worktree", "previous-worktree"]) {
    const document = store.open(
      editorDocumentId({
        server: scope.serverId,
        account: scope.ownerId,
        project: scope.projectId,
        worker: scope.workerId,
        worktree,
        path: "src/file.rs",
      }),
      "baseline\r\n",
      "v1",
    );
    document.editExternal(`draft in ${worktree}\n`);
  }
  return {
    ...scope,
    selectedPath: "src/file.rs",
    fileMode: "preview",
    documents: store.captureRecovery(),
  };
}

it("restores dirty recovery over disk content and keeps inactive recovered buffers", () => {
  const recovered = fixture();
  const live = structuredClone(recovered);
  live.documents.documents = live.documents.documents.slice(0, 1);
  live.documents.documents[0]!.text =
    live.documents.documents[0]!.baselineContent;
  const before = structuredClone(live);
  expect(mergeLegacyDocumentRecovery(live, recovered, scope).documents).toEqual(
    recovered.documents,
  );
  expect(live).toEqual(before);
});

it("does not overwrite a live draft with clean recovery", () => {
  const live = fixture();
  const recovered = structuredClone(live);
  for (const document of recovered.documents.documents)
    document.text = document.baselineContent;
  expect(mergeLegacyDocumentRecovery(live, recovered, scope).documents).toEqual(
    live.documents,
  );
});

it.each(["text", "baselineContent", "version"] as const)(
  "retains divergent dirty recovery when %s differs",
  (field) => {
    const live = fixture();
    const recovered = structuredClone(live);
    recovered.documents.documents[0]![field] += "different";
    expect(() => mergeLegacyDocumentRecovery(live, recovered, scope)).toThrow(
      "Both drafts have been retained",
    );
  },
);

it("preserves selected mode and every inactive draft with independent document bindings", () => {
  const original = fixture();
  const before = structuredClone(original);
  const candidates = planLegacyDocuments(original, scope);
  expect(candidates).toHaveLength(2);
  expect(
    candidates.map(({ selected, mode, worktreeId }) => ({
      selected,
      mode,
      worktreeId,
    })),
  ).toEqual([
    { selected: true, mode: "preview", worktreeId: "worktree" },
    { selected: false, mode: "edit", worktreeId: "previous-worktree" },
  ]);
  for (const [index, candidate] of candidates.entries()) {
    const converted = bindLegacyDocument(candidate, scope, {
      tabId: index === 0 ? "original-tab" : "retained-tab",
      documentId: `document-${index}`,
    });
    expect(converted.documents.documents).toEqual([
      original.documents.documents[index],
    ]);
    expect(converted.documents.documents[0]).not.toBe(
      original.documents.documents[index],
    );
    expect(converted.explorerId).toBe(
      index === 0 ? "original-tab" : "retained-tab",
    );
  }
  expect(original).toEqual(before);
});

it("retains a selected file with no loaded text, including media files", () => {
  const state = fixture();
  state.selectedPath = "image.png";
  expect(planLegacyDocuments(state, scope).map(({ path }) => path)).toEqual([
    "image.png",
    "src/file.rs",
    "src/file.rs",
  ]);
});

it("keeps tree-only Explorers distinct while recovering any retained buffers", () => {
  const state = fixture();
  state.selectedPath = null;
  expect(
    planLegacyDocuments(state, scope).every(({ selected }) => !selected),
  ).toBe(true);
  state.documents.documents = [];
  expect(planLegacyDocuments(state, scope)).toEqual([]);
});

it("rejects a foreign inactive buffer instead of partially migrating", () => {
  const state = fixture();
  state.documents.documents[1]!.id = JSON.stringify([
    "server",
    "another-owner",
    "worker",
    "project",
    "previous-worktree",
    "src/file.rs",
  ]);
  expect(() => planLegacyDocuments(state, scope)).toThrow(/mismatched/);
});

it("rejects rebinding an inactive buffer to the selected worktree", () => {
  const candidate = planLegacyDocuments(fixture(), scope)[1]!;
  expect(() =>
    bindLegacyDocument({ ...candidate, worktreeId: "worktree" }, scope, {
      tabId: "tab",
      documentId: "document",
    }),
  ).toThrow(/mismatched/);
});

it("does not migrate an already immutable document as a legacy Explorer", () => {
  expect(() =>
    planLegacyDocuments(fixture(), { ...scope, documentId: "document" }),
  ).toThrow(/legacy/);
});

it.each(["tabId", "documentId"] as const)(
  "rejects an empty %s binding",
  (field) => {
    const candidate = planLegacyDocuments(fixture(), scope)[0]!;
    expect(() =>
      bindLegacyDocument(candidate, scope, {
        tabId: "tab",
        documentId: "document",
        [field]: "",
      }),
    ).toThrow(/explicit/);
  },
);
