import { useEffect, useState } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import type { IncomingRemoteDesktopView } from "./remote-desktop-view-state";
import { PersistentRemoteDesktopViews } from "./persistent-remote-desktop-views";

const mock = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  unmount: vi.fn(),
  queries: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ getRemoteDesktop: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: any) => {
    mock.queries(options);
    return {
      data: mock.data.get(options.queryKey[1]) ?? options.initialData,
      isError: false,
    };
  },
}));
vi.mock("./managed-remote-desktop-view", () => ({
  ManagedRemoteDesktopView: (props: any) => {
    const [value, setValue] = useState("");
    useEffect(() => () => mock.unmount(props.desktop.id), []);
    return (
      <input
        data-tab={props.transferTabId}
        data-staged={Boolean(props.transferStaging)}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    );
  },
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const first = { tabId: "a", resourceId: "desktop-a", projectId: "project" };
const second = { tabId: "b", resourceId: "desktop-b", projectId: "project" };
beforeEach(() => {
  mock.unmount.mockClear();
  mock.queries.mockClear();
  mock.data.clear();
  for (const owner of [first, second])
    mock.data.set(owner.resourceId, {
      id: owner.resourceId,
      projectId: owner.projectId,
    });
});

it("preserves inactive renderer state and releases only closed tabs", async () => {
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(
      <PersistentRemoteDesktopViews
        owners={[first, second]}
        selectedTabId="a"
      />,
    );
  });
  try {
    const input = () => tree.root.findByProps({ "data-tab": "a" });
    await act(async () =>
      input().props.onChange({ target: { value: "local state" } }),
    );
    await act(async () =>
      tree.update(
        <PersistentRemoteDesktopViews
          owners={[first, second]}
          selectedTabId="b"
        />,
      ),
    );
    expect(input().props.value).toBe("local state");
    expect(mock.unmount).not.toHaveBeenCalled();
    await act(async () =>
      tree.update(
        <PersistentRemoteDesktopViews owners={[first]} selectedTabId="a" />,
      ),
    );
    expect(input().props.value).toBe("local state");
    expect(mock.unmount.mock.calls).toEqual([["desktop-b"]]);
  } finally {
    await act(async () => tree.unmount());
  }
});

it("keeps staging inert and preserves renderer identity across commit", async () => {
  const incoming = incomingDesktop(first.resourceId);
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(
      <PersistentRemoteDesktopViews
        owners={[]}
        incomingViews={[incoming]}
        selectedTabId="a"
      />,
    );
  });
  try {
    expect(
      tree.root.findByProps({
        "data-slot": "persistent-remote-desktop-surface",
      }).props.inert,
    ).toBe(true);
    expect(mock.queries.mock.lastCall![0].enabled).toBe(false);
    await act(async () =>
      tree.root
        .findByType("input")
        .props.onChange({ target: { value: "restored" } }),
    );
    await act(async () =>
      tree.update(
        <PersistentRemoteDesktopViews
          owners={[first]}
          incomingViews={[{ ...incoming, staging: undefined }]}
          selectedTabId="a"
        />,
      ),
    );
    expect(tree.root.findByType("input").props.value).toBe("restored");
    expect(tree.root.findByType("input").props["data-staged"]).toBe(false);
    expect(mock.unmount).not.toHaveBeenCalled();
  } finally {
    await act(async () => tree.unmount());
  }
});

it("does not replace an owned resource with stale incoming state", async () => {
  const incoming = incomingDesktop("other");
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(
      <PersistentRemoteDesktopViews
        owners={[first]}
        incomingViews={[incoming]}
        selectedTabId="a"
      />,
    );
  });
  try {
    expect(tree.root.findAllByType("input")).toHaveLength(1);
    expect(tree.root.findByType("input").props["data-staged"]).toBe(false);
    expect(mock.queries.mock.lastCall![0].queryKey).toEqual([
      "remote-desktop",
      first.resourceId,
    ]);
  } finally {
    await act(async () => tree.unmount());
  }
});

function incomingDesktop(id: string): IncomingRemoteDesktopView {
  return {
    tabId: "a",
    desktop: {
      id,
      projectId: "project",
      workerId: "worker",
      position: 0,
      stateRevision: 1,
      status: "active",
      lastError: null,
      title: "Desktop",
      target: { kind: "monitor", id: null, name: null },
      createdAt: "2026-10-24T00:00:00Z",
      updatedAt: "2026-10-24T00:00:00Z",
    },
    state: {
      version: 1,
      desktopId: id,
      projectId: "project",
      workerId: "worker",
      viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
      fleetOpen: true,
      targetSearch: "Editor",
    },
    staging: { onRestored() {}, onError() {} },
  };
}
