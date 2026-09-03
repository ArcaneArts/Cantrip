import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/explorer/explorer-code-editor", async () => {
  const { createElement: createMockElement } = await import("react");
  return {
    ExplorerCodeEditor: ({
      active,
      backgroundWarmup,
      path,
    }: {
      active: boolean;
      backgroundWarmup: boolean;
      path: string | null;
    }) =>
      createMockElement("div", {
        "data-editor-active": active,
        "data-editor-background-warmup": backgroundWarmup,
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
  prewarm: false,
  visible: true,
  retained: true,
  workerOnline: true,
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
          path: "src/one.ts",
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
          path: null,
          visible: false,
        }),
      );
    });

    expect(renderer.root.findByProps({ "data-mock-code-editor": true })).toBe(
      mountedEditor,
    );
    expect(mountedEditor.props["data-editor-path"]).toBe("src/one.ts");
    expect(mountedEditor.props["data-editor-active"]).toBe(false);
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
          path: "src/one.ts",
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
          path: "src/two.ts",
        }),
      );
    });

    expect(renderer.root.findByProps({ "data-mock-code-editor": true })).toBe(
      mountedEditor,
    );
    expect(mountedEditor.props["data-editor-path"]).toBe("src/two.ts");

    await act(async () => renderer.unmount());
  });

  it("does not create an inactive workbench before that surface is visible", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(RetainedExplorerCodeEditor, {
          ...baseProps,
          path: "src/first.ts",
          retained: false,
          visible: false,
        }),
      );
    });
    expect(
      renderer.root.findAllByProps({ "data-mock-code-editor": true }),
    ).toHaveLength(0);

    await act(async () => {
      renderer.update(
        createElement(RetainedExplorerCodeEditor, {
          ...baseProps,
          path: "src/first.ts",
        }),
      );
    });
    const mountedEditor = renderer.root.findByProps({
      "data-mock-code-editor": true,
    });
    expect(mountedEditor.props["data-editor-path"]).toBe("src/first.ts");

    await act(async () => {
      renderer.update(
        createElement(RetainedExplorerCodeEditor, {
          ...baseProps,
          path: "src/first.ts",
          visible: false,
        }),
      );
    });
    expect(renderer.root.findByProps({ "data-mock-code-editor": true })).toBe(
      mountedEditor,
    );
    expect(mountedEditor.props["data-editor-active"]).toBe(false);

    await act(async () => renderer.unmount());
  });

  it("mounts one hidden pathless prewarm and reuses it on first activation", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(RetainedExplorerCodeEditor, {
          ...baseProps,
          path: null,
          prewarm: true,
          visible: false,
        }),
      );
    });
    const mountedEditor = renderer.root.findByProps({
      "data-mock-code-editor": true,
    });
    expect(mountedEditor.props["data-editor-active"]).toBe(false);
    expect(mountedEditor.props["data-editor-background-warmup"]).toBe(true);
    expect(mountedEditor.props["data-editor-path"]).toBeNull();

    await act(async () => {
      renderer.update(
        createElement(RetainedExplorerCodeEditor, {
          ...baseProps,
          path: "src/first.ts",
          prewarm: false,
          visible: true,
        }),
      );
    });

    expect(renderer.root.findByProps({ "data-mock-code-editor": true })).toBe(
      mountedEditor,
    );
    expect(mountedEditor.props["data-editor-active"]).toBe(true);
    expect(mountedEditor.props["data-editor-background-warmup"]).toBe(false);
    expect(mountedEditor.props["data-editor-path"]).toBe("src/first.ts");

    await act(async () => renderer.unmount());
  });

  it("releases a hidden pathless editor when its prewarm role is revoked", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(RetainedExplorerCodeEditor, {
          ...baseProps,
          path: null,
          prewarm: true,
          visible: false,
        }),
      );
    });
    expect(
      renderer.root.findAllByProps({ "data-mock-code-editor": true }),
    ).toHaveLength(1);

    await act(async () => {
      renderer.update(
        createElement(RetainedExplorerCodeEditor, {
          ...baseProps,
          path: null,
          prewarm: false,
          retained: true,
          visible: false,
        }),
      );
    });

    expect(
      renderer.root.findAllByProps({ "data-mock-code-editor": true }),
    ).toHaveLength(0);

    await act(async () => renderer.unmount());
  });

  it("unmounts immediately when its binding retention is revoked", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(RetainedExplorerCodeEditor, {
          ...baseProps,
          path: "src/active.ts",
        }),
      );
    });
    expect(
      renderer.root.findAllByProps({ "data-mock-code-editor": true }),
    ).toHaveLength(1);

    await act(async () => {
      renderer.update(
        createElement(RetainedExplorerCodeEditor, {
          ...baseProps,
          path: "src/active.ts",
          retained: false,
          visible: false,
          workerId: "worker-2",
        }),
      );
    });
    expect(
      renderer.root.findAllByProps({ "data-mock-code-editor": true }),
    ).toHaveLength(0);

    await act(async () => renderer.unmount());
  });

  it("unmounts the workbench when its retention lease expires", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(RetainedExplorerCodeEditor, {
          ...baseProps,
          path: "src/one.ts",
        }),
      );
    });

    await act(async () => {
      renderer.update(
        createElement(RetainedExplorerCodeEditor, {
          ...baseProps,
          path: null,
          retained: false,
          visible: false,
        }),
      );
    });

    expect(
      renderer.root.findAllByProps({ "data-mock-code-editor": true }),
    ).toHaveLength(0);

    await act(async () => renderer.unmount());
  });

  it("bounds a hidden workbench while preserving the 2, 5, 10, and 16 minute windows", async () => {
    vi.useFakeTimers();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(RetainedExplorerCodeEditor, {
          ...baseProps,
          path: "src/one.ts",
        }),
      );
    });
    await act(async () => {
      renderer.update(
        createElement(RetainedExplorerCodeEditor, {
          ...baseProps,
          path: null,
          visible: false,
        }),
      );
    });

    let previousElapsedMinutes = 0;
    for (const elapsedMinutes of [2, 5, 10, 16]) {
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
        INLINE_CODE_WORKBENCH_RETENTION_MS - 16 * 60 * 1_000,
      );
    });
    expect(
      renderer.root.findAllByProps({ "data-mock-code-editor": true }),
    ).toHaveLength(0);

    await act(async () => renderer.unmount());
  });
});
