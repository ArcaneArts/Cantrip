import type { CodeTabSummary, ExplorerSummary } from "@cantrip/protocol";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import type { ExplorerTransferState } from "./explorer-view";

vi.mock("./explorer-view", () => ({
  ExplorerView: (props: {
    explorer: ExplorerSummary;
    initialTransfer?: ExplorerTransferState;
    transferStaging?: unknown;
  }) =>
    createElement("div", {
      "data-owner": props.explorer.id,
      snapshot: props.initialTransfer,
      staging: props.transferStaging,
    }),
}));
vi.mock("../code/code-view", () => ({
  CodeView: (props: {
    codeTab: CodeTabSummary;
    initialTransfer?: ExplorerTransferState;
    transferStaging?: unknown;
  }) =>
    createElement("div", {
      "data-owner": props.codeTab.id,
      snapshot: props.initialTransfer,
      staging: props.transferStaging,
    }),
}));
vi.mock("@/lib/client-log-relay", () => ({ clientLogger: { info: vi.fn() } }));
import { PersistentExplorerViews } from "./persistent-explorer-views";
import { PersistentCodeViews } from "../code/persistent-code-views";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it.each(["explorer", "code"])(
  "mounts an incoming %s before ownership and activates the same view after commit",
  async (kind) => {
    const resource = {
      id: "incoming",
      projectId: "project",
      worktreeId: "tree",
    } as ExplorerSummary;
    const snapshot = { explorerId: resource.id } as ExplorerTransferState;
    const staging = { onRestored: vi.fn(), onError: vi.fn() };
    const render = (committed: boolean, cancelled = false) => {
      const incomingViews = cancelled
        ? []
        : [
            {
              tabId: "view",
              resource,
              state: snapshot,
              staging: committed ? undefined : staging,
            },
          ];
      return kind === "explorer"
        ? createElement(PersistentExplorerViews, {
            activeExplorer: committed ? resource : null,
            openExplorers: committed ? [resource] : [],
            incomingViews,
            appearance: "dark",
            gitStatuses: {},
            repositoryGraphAvailable: false,
          })
        : createElement(PersistentCodeViews, {
            activeTab: committed ? resource : null,
            openTabs: committed ? [resource] : [],
            incomingViews,
            appearance: "dark",
          });
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    try {
      await act(async () => {
        renderer = TestRenderer.create(render(false));
      });
      const node = renderer.root.findByProps({ "data-owner": resource.id });
      expect(node.props.snapshot).toBe(snapshot);
      expect(node.props.staging).toBe(staging);
      await act(async () => {
        renderer.update(render(true));
      });
      expect(renderer.root.findByProps({ "data-owner": resource.id })).toBe(
        node,
      );
      expect(node.props.staging).toBeUndefined();
      await act(async () => {
        renderer.update(render(false, true));
      });
      expect(
        renderer.root.findAllByProps({ "data-owner": resource.id }),
      ).toHaveLength(0);
    } finally {
      await act(async () => renderer?.unmount());
    }
  },
);

it("routes staged state to active and inactive Explorer owners without mounting excluded views", async () => {
  const owners = ["active", "inactive", "excluded"].map(
    (id) =>
      ({ id, worktreeId: "worktree", projectId: "project" }) as ExplorerSummary,
  );
  const snapshots = new Map(
    owners.map(({ id }) => [id, { explorerId: id } as ExplorerTransferState]),
  );
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(PersistentExplorerViews, {
          activeExplorer: owners[0]!,
          openExplorers: owners,
          appearance: "dark",
          gitStatuses: {},
          repositoryGraphAvailable: false,
          initialTransfers: snapshots,
          excludedIds: new Set(["excluded"]),
        }),
      );
    });
    for (const id of ["active", "inactive"])
      expect(
        renderer.root.findByProps({ "data-owner": id }).props.snapshot,
      ).toBe(snapshots.get(id));
    expect(
      renderer.root.findAllByProps({ "data-owner": "excluded" }),
    ).toHaveLength(0);
  } finally {
    await act(async () => renderer?.unmount());
  }
});

it("routes a Code snapshot by its owner, not by the selected file or another editor", async () => {
  const tab = { id: "code" } as CodeTabSummary;
  const snapshot = { explorerId: "code" } as ExplorerTransferState;
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(PersistentCodeViews, {
          activeTab: tab,
          appearance: "dark",
          initialTransfers: new Map([
            ["code", snapshot],
            ["other", {} as ExplorerTransferState],
          ]),
        }),
      );
    });
    expect(
      renderer.root.findByProps({ "data-owner": "code" }).props.snapshot,
    ).toBe(snapshot);
  } finally {
    await act(async () => renderer?.unmount());
  }
});

it("mounts every owned Code tab, including inactive transfers beyond the cache limit, and releases removed owners", async () => {
  const tabs = Array.from(
    { length: 10 },
    (_, index) =>
      ({
        id: `code-${index}`,
      }) as CodeTabSummary,
  );
  const snapshots = new Map(
    tabs.map(({ id }) => [
      id,
      {
        explorerId: id,
      } as ExplorerTransferState,
    ]),
  );
  let renderer!: TestRenderer.ReactTestRenderer;
  const render = (
    openTabs: readonly CodeTabSummary[],
    unresolvedIds = new Set<string>(),
  ) =>
    createElement(PersistentCodeViews, {
      activeTab: tabs[0]!,
      openTabs,
      unresolvedIds,
      appearance: "dark",
      initialTransfers: snapshots,
      excludedIds: new Set(["code-9"]),
    });
  try {
    await act(async () => {
      renderer = TestRenderer.create(render(tabs));
    });
    for (const tab of tabs.slice(0, 9)) {
      expect(
        renderer.root.findByProps({ "data-owner": tab.id }).props.snapshot,
      ).toBe(snapshots.get(tab.id));
    }
    expect(
      renderer.root.findAllByProps({ "data-owner": "code-9" }),
    ).toHaveLength(0);
    await act(async () => {
      renderer.update(render([], new Set(["code-1"])));
    });
    expect(
      renderer.root.findAllByProps({ "data-owner": "code-0" }),
    ).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ "data-owner": "code-1" }),
    ).toHaveLength(1);
    await act(async () => {
      renderer.update(render([]));
    });
    expect(
      renderer.root.findAllByProps({ "data-owner": "code-1" }),
    ).toHaveLength(0);
  } finally {
    await act(async () => renderer?.unmount());
  }
});
