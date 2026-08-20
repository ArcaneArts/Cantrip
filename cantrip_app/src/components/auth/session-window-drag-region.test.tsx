import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SessionWindowDragRegion } from "./session-window-drag-region";

describe("SessionWindowDragRegion", () => {
  it("renders a Tauri drag strip for the macOS overlay titlebar", () => {
    const markup = renderToStaticMarkup(
      <SessionWindowDragRegion enabled={true} />,
    );

    expect(markup).toContain('data-slot="session-window-drag-region"');
    expect(markup).toContain('data-tauri-drag-region=""');
    expect(markup).toContain("fixed inset-x-0 top-0");
  });

  it("does not cover browser or mobile clients", () => {
    expect(
      renderToStaticMarkup(<SessionWindowDragRegion enabled={false} />),
    ).toBe("");
  });
});
