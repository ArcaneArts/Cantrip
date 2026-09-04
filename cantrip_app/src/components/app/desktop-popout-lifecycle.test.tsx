import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { expect, it, vi } from "vitest";

import {
  openOwnedDesktopPane,
  useDetachedDesktopPaneState,
} from "./desktop-popout-lifecycle";

it("claims before native open and releases only a failed pane", async () => {
  const order: string[] = [];
  const target = {
    activeTabKey: "terminal:one",
    paneId: "pane-a",
    projectId: "project-a",
  };
  const release = vi.fn(() => order.push("release:pane-a"));

  await expect(
    openOwnedDesktopPane({
      claim: () => order.push("claim:pane-a"),
      complete: () => order.push("complete:pane-a"),
      open: async () => {
        order.push("open:pane-a");
        throw new Error("native open failed");
      },
      release,
      target,
      title: "Terminal",
    }),
  ).rejects.toThrow("native open failed");
  expect(order).toEqual(["claim:pane-a", "open:pane-a", "release:pane-a"]);
  expect(release).toHaveBeenCalledOnce();

  order.length = 0;
  await expect(
    openOwnedDesktopPane({
      claim: () => order.push("claim:pane-b"),
      complete: () => order.push("complete:pane-b"),
      open: async () => {
        order.push("open:pane-b");
        return "created";
      },
      release: () => order.push("release:pane-b"),
      target: { ...target, paneId: "pane-b" },
      title: "Terminal",
    }),
  ).resolves.toBe("created");
  expect(order).toEqual(["claim:pane-b", "open:pane-b", "complete:pane-b"]);
});

it("tracks multiple detached panes and releases only the window that closes", async () => {
  let state!: ReturnType<typeof useDetachedDesktopPaneState>;
  const Probe = () => {
    state = useDetachedDesktopPaneState();
    return null;
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Probe));
  });

  await act(async () => {
    state.claimPane("pane-a", "project-a", "explorer-a");
    state.claimPane("pane-b", "project-b", null);
    state.completePaneClaim("pane-a");
    state.completePaneClaim("pane-b");
  });
  expect([...state.ownedPaneIds].sort()).toEqual(["pane-a", "pane-b"]);
  expect(state.claims.get("pane-a")).toEqual({
    explorerId: "explorer-a",
    phase: "detached",
    projectId: "project-a",
  });

  await act(async () => state.releasePane("pane-a"));
  expect([...state.ownedPaneIds]).toEqual(["pane-b"]);
  expect(state.claims.has("pane-a")).toBe(false);
  expect(state.claims.has("pane-b")).toBe(true);

  await act(async () => renderer.unmount());
});

it("discovers existing pane windows without replacing in-flight claims", async () => {
  let state!: ReturnType<typeof useDetachedDesktopPaneState>;
  const Probe = () => {
    state = useDetachedDesktopPaneState();
    return null;
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Probe));
  });
  await act(async () => {
    state.claimPane("pane-opening", "project-opening", "explorer-opening");
    state.reconcileDiscovery(
      "project-existing",
      ["pane-opening", "pane-existing", "pane-local"],
      new Set(["pane-existing"]),
    );
  });

  expect(state.claims.get("pane-opening")?.phase).toBe("detaching");
  expect(state.claims.get("pane-existing")).toEqual({
    explorerId: null,
    phase: "detached",
    projectId: "project-existing",
  });
  expect(state.claims.has("pane-local")).toBe(false);
  expect([...state.inspectedPaneIds].sort()).toEqual([
    "pane-existing",
    "pane-local",
    "pane-opening",
  ]);

  await act(async () => renderer.unmount());
});
