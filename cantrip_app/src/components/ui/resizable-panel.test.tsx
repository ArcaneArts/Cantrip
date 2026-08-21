import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ResizablePanel,
  clampResizablePanelWidth,
  persistResizablePanelWidth,
  readResizablePanelWidth,
  resizablePanelWidthFromKey,
  resizablePanelWidthFromPointer,
  suppressResizablePanelBodyInteraction,
} from "./resizable-panel";

const dimensions = {
  defaultWidth: 384,
  maxWidth: 640,
  minWidth: 320,
};

describe("resizable panel sizing", () => {
  it("clamps invalid and out-of-range widths", () => {
    expect(clampResizablePanelWidth(Number.NaN, 384, 320, 640)).toBe(384);
    expect(clampResizablePanelWidth(200, 384, 320, 640)).toBe(320);
    expect(clampResizablePanelWidth(900, 384, 320, 640)).toBe(640);
  });

  it("resizes from either panel edge", () => {
    expect(
      resizablePanelWidthFromPointer({
        ...dimensions,
        boundary: 1_000,
        clientX: 600,
        edge: "left",
      }),
    ).toBe(400);
    expect(
      resizablePanelWidthFromPointer({
        ...dimensions,
        boundary: 200,
        clientX: 600,
        edge: "right",
      }),
    ).toBe(400);
  });

  it("maps arrows, Home, and End according to the resize edge", () => {
    expect(
      resizablePanelWidthFromKey({
        ...dimensions,
        currentWidth: 400,
        edge: "left",
        key: "ArrowLeft",
      }),
    ).toBe(416);
    expect(
      resizablePanelWidthFromKey({
        ...dimensions,
        currentWidth: 400,
        edge: "right",
        key: "ArrowLeft",
      }),
    ).toBe(384);
    expect(
      resizablePanelWidthFromKey({
        ...dimensions,
        currentWidth: 400,
        edge: "left",
        key: "Home",
      }),
    ).toBe(320);
    expect(
      resizablePanelWidthFromKey({
        ...dimensions,
        currentWidth: 400,
        edge: "left",
        key: "End",
      }),
    ).toBe(640);
    expect(
      resizablePanelWidthFromKey({
        ...dimensions,
        currentWidth: 400,
        edge: "left",
        key: "Enter",
      }),
    ).toBeNull();
  });

  it("persists safely and falls back when storage is unavailable", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const options = { ...dimensions, storage, storageKey: "panel-width" };
    expect(readResizablePanelWidth(options)).toBe(384);
    persistResizablePanelWidth({ ...options, width: 444 });
    expect(readResizablePanelWidth(options)).toBe(444);

    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readResizablePanelWidth({ ...options, storage: blocked })).toBe(384);
    expect(() =>
      persistResizablePanelWidth({ ...options, storage: blocked, width: 500 }),
    ).not.toThrow();
  });

  it("restores body interaction styles after resizing", () => {
    const style = { cursor: "wait", userSelect: "text" };
    const restoreFirst = suppressResizablePanelBodyInteraction(style);
    const restoreSecond = suppressResizablePanelBodyInteraction(style);
    expect(style).toEqual({ cursor: "col-resize", userSelect: "none" });
    restoreFirst();
    expect(style).toEqual({ cursor: "col-resize", userSelect: "none" });
    restoreSecond();
    expect(style).toEqual({ cursor: "wait", userSelect: "text" });
    restoreSecond();
    expect(style).toEqual({ cursor: "wait", userSelect: "text" });
  });
});

describe("ResizablePanel", () => {
  it("renders one accessible handle and preserves closed-panel semantics", () => {
    const markup = renderToStaticMarkup(
      <ResizablePanel
        ariaLabel="Resize details"
        {...dimensions}
        handleDataSlot="details-resize-handle"
        open={false}
        shellDataSlot="details-shell"
        storageKey="details-width"
        surfaceDataSlot="details-surface"
      >
        <p>Details</p>
      </ResizablePanel>,
    );

    expect(markup).toContain('data-slot="details-shell"');
    expect(markup).toContain('data-slot="details-surface"');
    expect(markup).toContain('data-slot="details-resize-handle"');
    expect(markup).toContain('aria-label="Resize details"');
    expect(markup).toContain('aria-orientation="vertical"');
    expect(markup).toContain('aria-valuemin="320"');
    expect(markup).toContain('aria-valuemax="640"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('data-state="closed"');
    expect(markup).toContain("motion-reduce:transition-none");
  });
});
