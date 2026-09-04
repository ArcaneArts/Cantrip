import type { CodeTabSummary } from "@cantrip/protocol";
import { createElement, useEffect } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  mounted: [] as string[],
  released: [] as string[],
}));

vi.mock("./code-view", () => ({
  CodeView: ({ codeTab }: { codeTab: CodeTabSummary }) => {
    useEffect(() => {
      lifecycle.mounted.push(codeTab.id);
      return () => {
        lifecycle.released.push(codeTab.id);
      };
    }, [codeTab.id]);
    return createElement("div", {
      "data-code-owner": codeTab.id,
    });
  },
}));

import { PersistentCodeViews } from "./persistent-code-views";

it("unmounts the main Code owner before a detached pane can own it", async () => {
  const tab = { id: "code-detached", title: "Detached" } as CodeTabSummary;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(PersistentCodeViews, {
        activeTab: tab,
        appearance: "dark",
      }),
    );
  });
  expect(lifecycle.mounted).toEqual([tab.id]);

  await act(async () => {
    renderer.update(
      createElement(PersistentCodeViews, {
        activeTab: tab,
        appearance: "dark",
        excludedIds: new Set([tab.id]),
      }),
    );
  });

  expect(lifecycle.released).toEqual([tab.id]);
  expect(renderer.root.findAllByProps({ "data-code-owner": tab.id })).toEqual(
    [],
  );
});
