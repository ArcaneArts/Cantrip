import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/explorer/explorer-code-editor", async () => {
  const { createElement: createMockElement } = await import("react");
  return {
    ExplorerCodeEditor: ({ path }: { path: string }) =>
      createMockElement("div", {
        "data-editor-path": path,
        "data-mock-code-editor": true,
      }),
  };
});

import { RetainedExplorerCodeEditor } from "./retained-explorer-code-editor";
import { INLINE_CODE_WORKBENCH_RETENTION_MS } from "./use-retained-inline-workbench";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const baseProps = {
  appearance: "dark" as const,
  explorerId: "explorer-1",
  retained: true,
  workerId: "worker-1",
  worktreeId: "worktree-1",
};

describe("RetainedExplorerCodeEditor", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the same workbench mounted while non-Code content is visible", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(RetainedExplorerCodeEditor, {
          ...baseProps,
          activePath: "src/one.ts",
        }),
      );
    });
    const mountedEditor = renderer.root.findByProps({
      "data-mock-code-editor": true,
    });

    await act(async () => {
      renderer.update(
        createElement(RetainedExplorerCodeEditor, {
          ...baseProps,
          activePath: null,
        }),
      );
    });

    expect(renderer.root.findByProps({ "data-mock-code-editor": true })).toBe(
      mountedEditor,
    );
    expect(mountedEditor.props["data-editor-path"]).toBe("src/one.ts");
    expect(
      renderer.root.findByProps({
        "data-slot": "retained-explorer-code-editor",
      }).props["aria-hidden"],
    ).toBe(true);

    await act(async () => renderer.unmount());
  });

  it("navigates the retained workbench without replacing its instance", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(RetainedExplorerCodeEditor, {
          ...baseProps,
          activePath: "src/one.ts",
        }),
      );
    });
    const mountedEditor = renderer.root.findByProps({
      "data-mock-code-editor": true,
    });

    await act(async () => {
      renderer.update(
        createElement(RetainedExplorerCodeEditor, {
          ...baseProps,
          activePath: "src/two.ts",
        }),
      );
    });

    expect(renderer.root.findByProps({ "data-mock-code-editor": true })).toBe(
      mountedEditor,
    );
    expect(mountedEditor.props["data-editor-path"]).toBe("src/two.ts");

    await act(async () => renderer.unmount());
  });

  it("unmounts the workbench when its retention lease expires", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(RetainedExplorerCodeEditor, {
          ...baseProps,
          activePath: "src/one.ts",
        }),
      );
    });

    await act(async () => {
      renderer.update(
        createElement(RetainedExplorerCodeEditor, {
          ...baseProps,
          activePath: null,
          retained: false,
        }),
      );
    });

    expect(
      renderer.root.findAllByProps({ "data-mock-code-editor": true }),
    ).toHaveLength(0);

    await act(async () => renderer.unmount());
  });

  it("bounds a hidden workbench while preserving the 2, 5, and 10 minute windows", async () => {
    vi.useFakeTimers();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(RetainedExplorerCodeEditor, {
          ...baseProps,
          activePath: "src/one.ts",
        }),
      );
    });
    await act(async () => {
      renderer.update(
        createElement(RetainedExplorerCodeEditor, {
          ...baseProps,
          activePath: null,
        }),
      );
    });

    let previousElapsedMinutes = 0;
    for (const elapsedMinutes of [2, 5, 10]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          (elapsedMinutes - previousElapsedMinutes) * 60 * 1_000,
        );
      });
      expect(
        renderer.root.findAllByProps({ "data-mock-code-editor": true }),
      ).toHaveLength(1);
      previousElapsedMinutes = elapsedMinutes;
    }

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        INLINE_CODE_WORKBENCH_RETENTION_MS - 10 * 60 * 1_000,
      );
    });
    expect(
      renderer.root.findAllByProps({ "data-mock-code-editor": true }),
    ).toHaveLength(0);

    await act(async () => renderer.unmount());
  });
});
