import { act, create } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { ExplorerSummary } from "@cantrip/protocol";
import type { ExplorerLifecycleActions } from "@/components/explorer/explorer-view";
import type { WorkspaceCommandClient } from "@/lib/workspace-command-client";
import { migrateOwnedLegacyFile } from "@/lib/migrate-owned-legacy-file";
import { useLegacyDocumentMigration } from "./use-legacy-document-migration";
import {
  setNativeCodeLifecycle,
  nativeCodeOwnerKey,
} from "@/components/code/native-code-lifecycle";

vi.mock("@/lib/migrate-owned-legacy-file", () => ({
  migrateOwnedLegacyFile: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());

function fixture(reserved = false, code = false) {
  const tab = (id: string) => ({
    id,
    resource: {
      kind: "entity",
      definitionId: code ? "project.code" : "project.explorer",
      resourceId: id,
    },
  });
  const state = {
    disposed: false,
    authoritative: {
      windows: [
        { id: "main", panes: [{ tabs: [tab("local")] }] },
        { id: "other", panes: [{ tabs: [tab("foreign")] }] },
      ],
      pendingTransfers: reserved ? [{ tabIds: ["local"] }] : [],
    },
  };
  const controller = {
    getSnapshot: () => state,
    subscribe: () => () => {},
  } as unknown as WorkspaceCommandClient;
  const lifecycles = new Map<string, ExplorerLifecycleActions>([
    ["local", {} as ExplorerLifecycleActions],
    ["foreign", {} as ExplorerLifecycleActions],
  ]);
  const explorers = ["local", "foreign"].map((id) => ({
    id,
    selectedPath: "file.rs",
  })) as ExplorerSummary[];
  const options = {
    workspace: { controller, windowId: "main" },
    lifecycles,
    explorers,
    lifecycleRevision: 1,
    queryClient: new QueryClient(),
  };
  let result!: ReturnType<typeof useLegacyDocumentMigration>;
  function Harness() {
    result = useLegacyDocumentMigration(options);
    return null;
  }
  return { Harness, result: () => result, options };
}

it("converts Code only after its lifecycle mounts and ignores durable conversion receipts", async () => {
  const f = fixture(false, true);
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<f.Harness />);
  });
  expect(migrateOwnedLegacyFile).not.toHaveBeenCalled();
  await act(async () =>
    setNativeCodeLifecycle(
      nativeCodeOwnerKey("local"),
      {} as ExplorerLifecycleActions,
    ),
  );
  expect(migrateOwnedLegacyFile).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceKind: "code",
      tabId: "local",
      explorerId: "local",
    }),
  );
  await act(async () => renderer.unmount());
  vi.mocked(migrateOwnedLegacyFile).mockClear();
  f.options.workspace.controller.getSnapshot().authoritative.legacyCodeImports =
    [
      {
        tabId: "local",
        codeId: "local",
        views: [{ tabId: "file", documentId: "document", mode: "edit" }],
      },
    ];
  await act(async () => {
    renderer = create(<f.Harness />);
  });
  expect(migrateOwnedLegacyFile).not.toHaveBeenCalled();
  await act(async () => {
    renderer.unmount();
    setNativeCodeLifecycle(nativeCodeOwnerKey("local"), null);
  });
});

it("automatically migrates only the current window's mounted legacy files", async () => {
  const f = fixture();
  let renderer!: ReturnType<typeof create>;
  vi.mocked(migrateOwnedLegacyFile).mockResolvedValue();
  await act(async () => {
    renderer = create(<f.Harness />);
  });
  expect(migrateOwnedLegacyFile).toHaveBeenCalledOnce();
  expect(migrateOwnedLegacyFile).toHaveBeenCalledWith(
    expect.objectContaining({
      tabId: "local",
      explorerId: "local",
      windowId: "main",
    }),
  );
  await act(async () => renderer.unmount());
});

it("does not compete with an active transfer", async () => {
  const f = fixture(true);
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<f.Harness />);
  });
  expect(migrateOwnedLegacyFile).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});

it("retains failure until explicit retry rather than spinning on catalog renders", async () => {
  const f = fixture();
  let renderer!: ReturnType<typeof create>;
  const failure = new Error("Checkpoint unavailable");
  vi.mocked(migrateOwnedLegacyFile)
    .mockRejectedValueOnce(failure)
    .mockResolvedValue();
  await act(async () => {
    renderer = create(<f.Harness />);
  });
  expect(f.result().error).toBe(failure);
  await act(async () => renderer.update(<f.Harness />));
  expect(migrateOwnedLegacyFile).toHaveBeenCalledOnce();
  await act(async () => f.result().retry());
  expect(migrateOwnedLegacyFile).toHaveBeenCalledTimes(2);
  expect(f.result().error).toBeNull();
  await act(async () => renderer.unmount());
});

it("waits for a mounted lifecycle and ignores tree-only Explorers", async () => {
  const f = fixture();
  let renderer!: ReturnType<typeof create>;
  f.options.lifecycles.clear();
  await act(async () => {
    renderer = create(<f.Harness />);
  });
  expect(migrateOwnedLegacyFile).not.toHaveBeenCalled();
  f.options.lifecycles.set("local", {} as ExplorerLifecycleActions);
  f.options.explorers[0]!.selectedPath = null;
  f.options.lifecycleRevision++;
  await act(async () => renderer.update(<f.Harness />));
  expect(migrateOwnedLegacyFile).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});
