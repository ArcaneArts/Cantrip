import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ExplorerFilePopout } from "./explorer-file-popout";

describe("ExplorerFilePopout", () => {
  it("relies on native window controls instead of rendering a close button", () => {
    const markup = renderToStaticMarkup(
      <ExplorerFilePopout
        appearance="dark"
        error={null}
        explorer={null}
        loading
        overlayTitlebar
        path="src/example.ts"
        projectTitle="Cantrip"
      />,
    );

    expect(markup).not.toContain('title="Close file"');
    expect(markup).not.toContain("Close file</span>");
    expect(markup).not.toContain("example.ts");
    expect(markup).toContain("data-tauri-drag-region");
  });
});
