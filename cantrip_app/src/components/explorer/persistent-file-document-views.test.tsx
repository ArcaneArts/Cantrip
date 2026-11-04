// @vitest-environment jsdom
import { saveEditorOpeningMode } from "@/lib/editor-preferences";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CodeAppearance } from "@cantrip/protocol";
import type { ProjectSurface } from "@/lib/project-surface";
import { FileDocumentView } from "./file-document-view";
import { PersistentFileDocumentViews } from "./persistent-file-document-views";

vi.mock("./file-document-view", () => ({ FileDocumentView: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let renderer: ReactTestRenderer | undefined;
beforeEach(() => localStorage.clear());
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});

const document = {
  id: "doc",
  projectId: "project",
  workerId: "worker",
  worktreeId: "tree",
  path: "src/lib.rs",
  createdAt: "2026-10-24T00:00:00Z",
};
function surface(
  kind: "file" | "unresolved" = "file",
  resourceId = "doc",
): ProjectSurface {
  return {
    kind,
    tabKey: "tab",
    projectId: "project",
    entity: kind === "file" ? document : null,
    resource: {
      ref: { kind: "entity", definitionId: "project.file", resourceId },
    },
  } as ProjectSurface;
}
const onOpenFile = vi.fn();
const onModeChange = vi.fn(async (_tabId: string, _mode: string) => {});
it("retains editor callbacks when shell commands change and calls the latest command", async () => {
  const first = vi.fn();
  const latest = vi.fn();
  const modes = vi.fn(async () => {});
  const render = (open: typeof first) => (
    <PersistentFileDocumentViews
      surfaces={[surface()]}
      activeTabId="tab"
      appearance={{} as CodeAppearance}
      onOpenFile={open}
      onModeChange={async () => {
        await modes();
      }}
    />
  );
  await act(async () => {
    renderer = create(render(first));
  });
  const before = renderer!.root.findByType(FileDocumentView).props;
  await act(async () => renderer!.update(render(latest)));
  const after = renderer!.root.findByType(FileDocumentView).props;
  expect(after.onOpenFile).toBe(before.onOpenFile);
  expect(after.onModeChange).toBe(before.onModeChange);
  after.onOpenFile("next.rs");
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledWith("project", "tree", "next.rs");
  await act(async () => after.onModeChange("preview"));
  expect(modes).toHaveBeenCalledOnce();
});
it("mounts incoming document views passively with their transfer state", async () => {
  const state = {
    explorerId: "incoming-tab",
    documentId: document.id,
    fileMode: "preview" as const,
  } as import("./explorer-view").ExplorerTransferState;
  const staging = { onRestored: vi.fn(), onError: vi.fn() };
  await act(async () => {
    renderer = create(
      <PersistentFileDocumentViews
        surfaces={[]}
        appearance={{} as CodeAppearance}
        onOpenFile={onOpenFile}
        incomingViews={[
          { tabId: "incoming-tab", resource: document, state, staging },
        ]}
      />,
    );
  });
  const view = renderer!.root.findByType(FileDocumentView);
  expect(view.props.active).toBe(false);
  expect(view.props.mode).toBe("preview");
  expect(view.props.initialTransfer).toBe(state);
  expect(view.props.transferStaging).toBe(staging);
  expect(staging.onRestored).not.toHaveBeenCalled();
});
function tree(surfaces: ProjectSurface[], activeTabId = "tab") {
  return (
    <PersistentFileDocumentViews
      surfaces={surfaces}
      activeTabId={activeTabId}
      appearance={{} as CodeAppearance}
      onOpenFile={onOpenFile}
      onModeChange={onModeChange}
    />
  );
}

it("keeps a mounted document and explicit mode when hidden or temporarily unresolved", async () => {
  await act(async () => {
    renderer = create(tree([surface()]));
  });
  let view = renderer!.root.findByType(FileDocumentView);
  expect(view.props.mode).toBe("edit");
  expect(view.props.tabId).toBe("tab");
  await act(async () => view.props.onModeChange("preview"));
  expect(onModeChange).toHaveBeenCalledWith("tab", "preview");
  await act(async () =>
    renderer!.update(tree([surface("unresolved")], "other-tab")),
  );
  view = renderer!.root.findByType(FileDocumentView);
  expect(view.props.mode).toBe("preview");
  expect(view.props.document).toBe(document);
  expect(view.props.active).toBe(false);
  await act(async () => renderer!.update(tree([surface()])));
  expect(renderer!.root.findByType(FileDocumentView).props.mode).toBe(
    "preview",
  );
});

it("restores saved mode after remount and follows authoritative changes", async () => {
  await act(async () => {
    renderer = create(tree([{ ...surface(), fileMode: "visual" }]));
  });
  expect(renderer!.root.findByType(FileDocumentView).props.mode).toBe("visual");
  await act(async () =>
    renderer!.update(tree([{ ...surface(), fileMode: "preview" }])),
  );
  expect(renderer!.root.findByType(FileDocumentView).props.mode).toBe(
    "preview",
  );
  await act(async () => renderer!.unmount());
  await act(async () => {
    renderer = create(tree([{ ...surface(), fileMode: "preview" }]));
  });
  expect(renderer!.root.findByType(FileDocumentView).props.mode).toBe(
    "preview",
  );
});

it("does not report a rejected mode write as saved", async () => {
  await act(async () => {
    renderer = create(tree([surface()]));
  });
  onModeChange.mockRejectedValueOnce(new Error("Mode write failed"));
  await act(async () => {
    await expect(
      renderer!.root.findByType(FileDocumentView).props.onModeChange("preview"),
    ).rejects.toThrow("Mode write failed");
  });
  expect(renderer!.root.findByType(FileDocumentView).props.mode).toBe("edit");
});

it("unmounts a closed view and does not reuse its document for another resource", async () => {
  await act(async () => {
    renderer = create(tree([surface()]));
  });
  await act(async () =>
    renderer!.update(tree([surface("unresolved", "other-document")])),
  );
  expect(renderer!.root.findAllByType(FileDocumentView)).toHaveLength(0);
  await act(async () => renderer!.update(tree([surface()])));
  expect(renderer!.root.findAllByType(FileDocumentView)).toHaveLength(1);
  await act(async () => renderer!.update(tree([])));
  expect(renderer!.root.findAllByType(FileDocumentView)).toHaveLength(0);
  await act(async () => renderer!.update(tree([surface("unresolved")])));
  expect(renderer!.root.findAllByType(FileDocumentView)).toHaveLength(0);
});

it("retains a Linux document's captured placement when following a link", async () => {
  const entity = {
    ...document,
    cantripOsBindingId: "binding",
    cantripOsRuntimeGeneration: "generation",
  };
  await act(async () => {
    renderer = create(tree([{ ...surface(), entity } as ProjectSurface]));
  });
  renderer!.root.findByType(FileDocumentView).props.onOpenFile("next.py");
  expect(onOpenFile).toHaveBeenLastCalledWith("project", "tree", "next.py", {
    cantripOsBindingId: "binding",
    cantripOsRuntimeGeneration: "generation",
    workerId: "worker",
  });
});

it("routes document links with their project and worktree instead of rebinding the view", async () => {
  await act(async () => {
    renderer = create(tree([surface()]));
  });
  renderer!.root.findByType(FileDocumentView).props.onOpenFile("src/next.rs");
  expect(onOpenFile).toHaveBeenCalledWith("project", "tree", "src/next.rs");
  expect(renderer!.root.findByType(FileDocumentView).props.document.path).toBe(
    "src/lib.rs",
  );
});

it("defaults new log document views to preview without changing an explicit saved mode", async () => {
  const log = {
    ...surface(),
    entity: { ...document, path: "daemon.log" },
  } as ProjectSurface;
  await act(async () => {
    renderer = create(tree([log]));
  });
  expect(renderer!.root.findByType(FileDocumentView).props.mode).toBe(
    "preview",
  );
  await act(async () =>
    renderer!.root.findByType(FileDocumentView).props.onModeChange("edit"),
  );
  expect(renderer!.root.findByType(FileDocumentView).props.mode).toBe("edit");
});

it("uses opening preferences for new tabs while preserving current and saved modes", async () => {
  const json = {
    ...surface(),
    entity: { ...document, path: "settings.json" },
  } as ProjectSurface;
  saveEditorOpeningMode("json", "visual");
  await act(async () => {
    renderer = create(tree([json]));
  });
  expect(renderer!.root.findByType(FileDocumentView).props.mode).toBe("visual");
  await act(async () => {
    saveEditorOpeningMode("json", "edit");
    renderer!.update(tree([json]));
  });
  expect(renderer!.root.findByType(FileDocumentView).props.mode).toBe("visual");
  await act(async () =>
    renderer!.update(tree([{ ...json, fileMode: "preview" }])),
  );
  expect(renderer!.root.findByType(FileDocumentView).props.mode).toBe(
    "preview",
  );
  await act(async () => renderer!.unmount());
  await act(async () => {
    renderer = create(tree([{ ...json, fileMode: "preview" }]));
  });
  expect(renderer!.root.findByType(FileDocumentView).props.mode).toBe(
    "preview",
  );
  await act(async () => renderer!.update(tree([])));
  await act(async () => renderer!.update(tree([json])));
  expect(renderer!.root.findByType(FileDocumentView).props.mode).toBe("edit");
});
