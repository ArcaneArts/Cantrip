import type { BrowserSummary } from "@cantrip/protocol";
import { useState } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import {
  PersistentBrowserViews,
  reconcileBrowserOwners,
} from "./persistent-browser-views";

vi.mock("./browser-view", () => ({
  BrowserView: ({
    browser,
    visible,
  }: {
    browser: BrowserSummary;
    visible: boolean;
  }) => {
    const [draft, setDraft] = useState(browser.url);
    return (
      <input
        data-browser={browser.id}
        data-visible={visible}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    );
  },
}));

const browser = (id: string) =>
  ({
    id,
    url: `https://${id}.example`,
    projectId: "project",
  }) as BrowserSummary;
const first = { tabId: "view-a", resourceId: "a", browser: browser("a") };
const second = { tabId: "view-b", resourceId: "b", browser: browser("b") };

describe("browser view ownership", () => {
  it("retains resolved metadata through query gaps, not through close or resource replacement", () => {
    expect(
      reconcileBrowserOwners(
        [first],
        [{ tabId: first.tabId, resourceId: "a" }],
      ),
    ).toEqual([first]);
    expect(reconcileBrowserOwners([first], [])).toEqual([]);
    expect(
      reconcileBrowserOwners(
        [first],
        [{ tabId: first.tabId, resourceId: "other" }],
      )[0]?.browser,
    ).toBeUndefined();
    expect(
      reconcileBrowserOwners([], [{ tabId: first.tabId, resourceId: "a" }])[0]
        ?.browser,
    ).toBeUndefined();
  });

  it("keeps inactive address drafts and releases only the closed view", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const props = {
      owners: [first, second],
      selectedTabId: first.tabId,
      fleetDiscovery: false,
      onOpenService: vi.fn(),
      onPageState: vi.fn(),
    };
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(<PersistentBrowserViews {...props} />);
    });
    const input = () =>
      tree.root
        .findAllByType("input")
        .find((node) => node.props["data-browser"] === "a")!;
    await act(async () => {
      input().props.onChange({ target: { value: "unfinished address" } });
    });
    await act(async () => {
      tree.update(
        <PersistentBrowserViews {...props} selectedTabId={second.tabId} />,
      );
    });
    expect(input().props.value).toBe("unfinished address");
    expect(input().props["data-visible"]).toBe(false);
    await act(async () => {
      tree.update(
        <PersistentBrowserViews
          {...props}
          owners={[{ tabId: first.tabId, resourceId: "a" }, second]}
        />,
      );
    });
    expect(input().props.value).toBe("unfinished address");
    expect(input().props["data-visible"]).toBe(true);
    await act(async () => {
      tree.update(
        <PersistentBrowserViews
          {...props}
          placements={[{ tabId: first.tabId, paneId: "dock" }]}
        />,
      );
    });
    expect(input().props.value).toBe("unfinished address");
    await act(async () => {
      tree.update(<PersistentBrowserViews {...props} />);
    });
    expect(input().props.value).toBe("unfinished address");
    await act(async () => {
      tree.update(
        <PersistentBrowserViews
          {...props}
          owners={[second]}
          selectedTabId={second.tabId}
        />,
      );
    });
    expect(tree.root.findAllByType("input")).toHaveLength(1);
    expect(tree.root.findByType("input").props["data-browser"]).toBe("b");
    await act(async () => tree.unmount());
  });
});
