import type { ExplorerSummary } from "@cantrip/protocol";
import { createElement, useRef } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const explorerViewRuntime = vi.hoisted(() => ({ nextInstance: 0 }));

vi.mock("@/components/explorer/explorer-view", () => ({
  ExplorerView: ({
    active,
    explorer,
    keepInlineCodeWarm,
    onOpenFile,
    transientFile,
  }: {
    active: boolean;
    explorer: ExplorerSummary;
    keepInlineCodeWarm?: boolean;
    onOpenFile?: () => void;
    transientFile?: { path: string };
  }) => {
    const instance = useRef<number | null>(null);
    instance.current ??= ++explorerViewRuntime.nextInstance;
    return createElement("div", {
      "data-active": active,
      "data-explorer-id": explorer.id,
      "data-instance": instance.current,
      "data-has-on-open-file": Boolean(onOpenFile),
      "data-keep-inline-code-warm": keepInlineCodeWarm,
      "data-mock-explorer-view": true,
      "data-transient-path": transientFile?.path,
    });
  },
}));

import {
  MAX_RETAINED_EXPLORER_VIEWS,
  PersistentExplorerViews,
  retainExplorerSurfaceTabs,
  retainRequestedExplorerSurfaceTabs,
} from "./persistent-explorer-views";

function explorer(id: string): ExplorerSummary {
  return { id, title: id } as ExplorerSummary;
}

describe("retainExplorerSurfaceTabs", () => {
  beforeEach(() => {
    explorerViewRuntime.nextInstance = 0;
  });

  it("keeps an existing Explorer mounted and moves it to the MRU end", () => {
    expect(
      retainExplorerSurfaceTabs(
        [explorer("one"), explorer("two")],
        explorer("one"),
      ).map(({ id }) => id),
    ).toEqual(["two", "one"]);
  });

  it("bounds clean retained views without evicting the active Explorer", () => {
    const retained = Array.from(
      { length: MAX_RETAINED_EXPLORER_VIEWS },
      (_, index) => explorer(String(index)),
    );
    const next = retainExplorerSurfaceTabs(retained, explorer("active"));

    expect(next).toHaveLength(MAX_RETAINED_EXPLORER_VIEWS);
    expect(next.at(-1)?.id).toBe("active");
    expect(next.some(({ id }) => id === "0")).toBe(false);
  });

  it("retains dirty inactive editors beyond the normal memory bound", () => {
    const retained = Array.from(
      { length: MAX_RETAINED_EXPLORER_VIEWS },
      (_, index) => explorer(String(index)),
    );
    const dirtyIds = new Set(retained.map(({ id }) => id));
    const next = retainExplorerSurfaceTabs(
      retained,
      explorer("active"),
      dirtyIds,
    );

    expect(next).toHaveLength(MAX_RETAINED_EXPLORER_VIEWS + 1);
    expect(next.map(({ id }) => id)).toContain("0");
    expect(next.at(-1)?.id).toBe("active");
  });

  it("protects both requested views when every retained view is dirty", () => {
    const retained = Array.from(
      { length: MAX_RETAINED_EXPLORER_VIEWS },
      (_, index) => explorer(String(index)),
    );
    const next = retainRequestedExplorerSurfaceTabs(
      retained,
      explorer("active"),
      explorer("prewarm"),
      new Set(retained.map(({ id }) => id)),
    );

    expect(next.map(({ id }) => id)).toContain("prewarm");
    expect(next.at(-1)?.id).toBe("active");
  });

  it("protects an inactive transient view while trimming clean views", () => {
    const retained = [
      explorer("preview"),
      ...Array.from({ length: 7 }, (_, index) => explorer(String(index))),
    ];
    const next = retainRequestedExplorerSurfaceTabs(
      retained,
      explorer("active"),
      explorer("prewarm"),
      new Set(),
      new Set(["preview"]),
    );

    expect(next.map(({ id }) => id)).toContain("preview");
    expect(next.map(({ id }) => id)).toContain("prewarm");
    expect(next.at(-1)?.id).toBe("active");
  });

  it("reuses one keyed Explorer view for a sidebar transient preview", async () => {
    const active = {
      ...explorer("explorer-one"),
      activeWorkerId: "worker-one",
      projectId: "project-one",
      selectedPath: "src/retained.ts",
      worktreeId: "worktree-one",
    } as ExplorerSummary;
    const render = (transientPath?: string) =>
      createElement(PersistentExplorerViews, {
        activeExplorer: active,
        appearance: "dark",
        gitStatuses: {},
        repositoryGraphAvailable: false,
        transientFile: transientPath
          ? {
              explorerId: active.id,
              file: { close: vi.fn(), path: transientPath },
            }
          : undefined,
      });
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(render());
    });
    const retained = renderer.root.findByProps({
      "data-mock-explorer-view": true,
    });

    await act(async () => {
      renderer.update(render("src/sidebar-preview.ts"));
    });
    const views = renderer.root.findAllByProps({
      "data-mock-explorer-view": true,
    });

    expect(views).toHaveLength(1);
    expect(views[0]?.props["data-instance"]).toBe(
      retained.props["data-instance"],
    );
    expect(views[0]?.props["data-transient-path"]).toBe(
      "src/sidebar-preview.ts",
    );

    await act(async () => renderer.unmount());
  });

  it("keeps an identity-scoped preview mounted while another Explorer is active", async () => {
    const preview = {
      ...explorer("preview-explorer"),
      activeWorkerId: "worker-preview",
      projectId: "project-one",
      worktreeId: "worktree-preview",
    } as ExplorerSummary;
    const other = {
      ...explorer("other-explorer"),
      activeWorkerId: "worker-other",
      projectId: "project-one",
      worktreeId: "worktree-other",
    } as ExplorerSummary;
    const transientFile = {
      explorerId: preview.id,
      file: { close: vi.fn(), path: "src/sidebar-preview.ts" },
    };
    const render = (activeExplorer: ExplorerSummary) =>
      createElement(PersistentExplorerViews, {
        activeExplorer,
        appearance: "dark",
        gitStatuses: {},
        repositoryGraphAvailable: false,
        transientFile,
      });
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(render(preview));
    });
    const initialInstance = renderer.root.findByProps({
      "data-explorer-id": preview.id,
    }).props["data-instance"];

    await act(async () => renderer.update(render(other)));
    const inactivePreview = renderer.root.findByProps({
      "data-explorer-id": preview.id,
    });
    expect(inactivePreview.props["data-active"]).toBe(false);
    expect(inactivePreview.props["data-transient-path"]).toBe(
      "src/sidebar-preview.ts",
    );

    await act(async () => renderer.update(render(preview)));
    expect(
      renderer.root.findByProps({ "data-explorer-id": preview.id }).props[
        "data-instance"
      ],
    ).toBe(initialInstance);

    await act(async () => renderer.unmount());
  });

  it("keeps the same inactive preview instance beyond the clean retention cap", async () => {
    const preview = {
      ...explorer("preview-explorer"),
      activeWorkerId: "worker-preview",
      projectId: "project-one",
      worktreeId: "worktree-preview",
    } as ExplorerSummary;
    const transientFile = {
      explorerId: preview.id,
      file: { close: vi.fn(), path: "src/sidebar-preview.ts" },
    };
    const render = (activeExplorer: ExplorerSummary) =>
      createElement(PersistentExplorerViews, {
        activeExplorer,
        appearance: "dark",
        gitStatuses: {},
        repositoryGraphAvailable: false,
        transientFile,
      });
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(render(preview));
    });
    const initialInstance = renderer.root.findByProps({
      "data-explorer-id": preview.id,
    }).props["data-instance"];

    for (let index = 0; index <= MAX_RETAINED_EXPLORER_VIEWS; index += 1) {
      await act(async () =>
        renderer.update(
          render({
            ...explorer(`other-${index}`),
            activeWorkerId: `worker-${index}`,
            projectId: "project-one",
            worktreeId: `worktree-${index}`,
          } as ExplorerSummary),
        ),
      );
    }

    const retainedPreview = renderer.root.findByProps({
      "data-explorer-id": preview.id,
    });
    expect(retainedPreview.props["data-instance"]).toBe(initialInstance);
    expect(retainedPreview.props["data-transient-path"]).toBe(
      "src/sidebar-preview.ts",
    );

    await act(async () => renderer.unmount());
  });

  it("retains distinct active and staged Explorers once with the active view last", async () => {
    const active = {
      ...explorer("active-explorer"),
      activeWorkerId: "worker-active",
      worktreeId: "worktree-active",
    } as ExplorerSummary;
    const prewarm = {
      ...explorer("prewarm-explorer"),
      activeWorkerId: "worker-prewarm",
      worktreeId: "worktree-prewarm",
    } as ExplorerSummary;
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        createElement(PersistentExplorerViews, {
          activeExplorer: active,
          appearance: "dark",
          gitStatuses: {},
          prewarmExplorer: prewarm,
          repositoryGraphAvailable: false,
        }),
      );
    });
    const views = renderer.root.findAllByProps({
      "data-mock-explorer-view": true,
    });

    expect(views.map((view) => view.props["data-explorer-id"])).toEqual([
      "prewarm-explorer",
      "active-explorer",
    ]);
    expect(views.filter((view) => view.props["data-active"])).toHaveLength(1);
    expect(views[0]?.props["data-has-on-open-file"]).toBe(false);

    await act(async () => renderer.unmount());
  });

  it("promotes the warm successor without remounting it and provisions one replacement", async () => {
    const source = {
      ...explorer("preview-source"),
      activeWorkerId: "worker-one",
      projectId: "project-one",
      worktreeId: "worktree-one",
    } as ExplorerSummary;
    const successor = {
      ...source,
      id: "preview-successor",
    } as ExplorerSummary;
    const replacement = {
      ...source,
      id: "preview-replacement",
    } as ExplorerSummary;
    const render = ({
      active,
      open,
      primary,
      next,
    }: {
      active: ExplorerSummary;
      open: readonly ExplorerSummary[];
      primary: ExplorerSummary;
      next: ExplorerSummary;
    }) =>
      createElement(PersistentExplorerViews, {
        activeExplorer: active,
        appearance: "dark",
        gitStatuses: {},
        openExplorers: open,
        prewarmExplorer: primary,
        prewarmSuccessorExplorer: next,
        repositoryGraphAvailable: false,
      });
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        render({ active: source, next: successor, open: [], primary: source }),
      );
    });
    const successorInstance = renderer.root.findByProps({
      "data-explorer-id": successor.id,
    }).props["data-instance"];

    await act(async () => {
      renderer.update(
        render({
          active: successor,
          next: replacement,
          open: [source],
          primary: successor,
        }),
      );
    });
    const views = renderer.root.findAllByProps({
      "data-mock-explorer-view": true,
    });
    expect(views.map((view) => view.props["data-explorer-id"])).toEqual([
      source.id,
      successor.id,
      replacement.id,
    ]);
    expect(
      renderer.root.findByProps({ "data-explorer-id": successor.id }).props[
        "data-instance"
      ],
    ).toBe(successorInstance);
    expect(
      renderer.root.findByProps({ "data-explorer-id": successor.id }).props[
        "data-active"
      ],
    ).toBe(true);
    await act(async () => renderer.unmount());
  });

  it("owns every open Explorer tab across switches and removes only a closed tab", async () => {
    const first = {
      ...explorer("first-explorer"),
      activeWorkerId: "worker-one",
      projectId: "project-one",
      selectedPath: "src/first.ts",
      worktreeId: "worktree-one",
    } as ExplorerSummary;
    const second = {
      ...explorer("second-explorer"),
      activeWorkerId: "worker-one",
      projectId: "project-one",
      selectedPath: "src/second.ts",
      worktreeId: "worktree-one",
    } as ExplorerSummary;
    const preview = {
      ...explorer("preview-explorer"),
      activeWorkerId: "worker-one",
      projectId: "project-one",
      selectedPath: null,
      worktreeId: "worktree-one",
    } as ExplorerSummary;
    const render = (
      activeExplorer: ExplorerSummary,
      openExplorers: ExplorerSummary[],
    ) =>
      createElement(PersistentExplorerViews, {
        activeExplorer,
        appearance: "dark",
        gitStatuses: {},
        openExplorers,
        prewarmExplorer: preview,
        repositoryGraphAvailable: false,
      });
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(render(first, [first, second]));
    });
    const initialInstances = new Map(
      renderer.root
        .findAllByProps({ "data-mock-explorer-view": true })
        .map((view) => [
          view.props["data-explorer-id"] as string,
          view.props["data-instance"] as number,
        ]),
    );
    expect([...initialInstances.keys()]).toEqual([
      first.id,
      second.id,
      preview.id,
    ]);

    await act(async () => renderer.update(render(second, [first, second])));
    for (const explorerId of [first.id, second.id, preview.id]) {
      const view = renderer.root.findByProps({
        "data-explorer-id": explorerId,
      });
      expect(view.props["data-instance"]).toBe(
        initialInstances.get(explorerId),
      );
    }
    expect(
      renderer.root.findByProps({ "data-explorer-id": first.id }).props[
        "data-keep-inline-code-warm"
      ],
    ).toBe(true);
    expect(
      renderer.root.findByProps({ "data-explorer-id": second.id }).props[
        "data-keep-inline-code-warm"
      ],
    ).toBe(true);
    expect(
      renderer.root.findByProps({ "data-explorer-id": preview.id }).props[
        "data-keep-inline-code-warm"
      ],
    ).toBe(false);

    await act(async () => renderer.update(render(second, [second])));
    expect(
      renderer.root.findAllByProps({ "data-explorer-id": first.id }),
    ).toHaveLength(0);
    expect(
      renderer.root.findByProps({ "data-explorer-id": second.id }).props[
        "data-instance"
      ],
    ).toBe(initialInstances.get(second.id));
    expect(
      renderer.root.findByProps({ "data-explorer-id": preview.id }).props[
        "data-instance"
      ],
    ).toBe(initialInstances.get(preview.id));

    await act(async () => renderer.unmount());
  });

  it("keeps external file opening only on a non-prewarm Explorer", async () => {
    const active = {
      ...explorer("active-explorer"),
      activeWorkerId: "worker-active",
      worktreeId: "worktree-active",
    } as ExplorerSummary;
    const prewarm = {
      ...explorer("prewarm-explorer"),
      activeWorkerId: "worker-prewarm",
      worktreeId: "worktree-prewarm",
    } as ExplorerSummary;
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        createElement(PersistentExplorerViews, {
          activeExplorer: active,
          appearance: "dark",
          gitStatuses: {},
          onOpenFile: vi.fn(),
          prewarmExplorer: prewarm,
          repositoryGraphAvailable: false,
        }),
      );
    });

    expect(
      renderer.root.findByProps({ "data-explorer-id": active.id }).props[
        "data-has-on-open-file"
      ],
    ).toBe(true);
    expect(
      renderer.root.findByProps({ "data-explorer-id": prewarm.id }).props[
        "data-has-on-open-file"
      ],
    ).toBe(false);

    await act(async () => renderer.unmount());
  });
});
