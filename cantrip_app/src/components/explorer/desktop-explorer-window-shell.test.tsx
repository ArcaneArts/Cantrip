import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DesktopExplorerWindowHeader,
  DesktopExplorerWindowLoadingShell,
} from "./desktop-explorer-window-shell";

describe("Desktop Explorer window shell", () => {
  it("keeps the title and its loading shell draggable", () => {
    const header = renderToStaticMarkup(
      <DesktopExplorerWindowHeader path="src/index.ts" />,
    );
    const shell = renderToStaticMarkup(
      <DesktopExplorerWindowLoadingShell path="src/index.ts" />,
    );

    expect(header.match(/data-tauri-drag-region/g)).toHaveLength(2);
    expect(shell).toContain("src/index.ts");
    expect(shell).toContain('aria-label="Loading editor"');
  });

  it("does not turn title-bar controls into drag targets", () => {
    const header = renderToStaticMarkup(
      <DesktopExplorerWindowHeader
        actions={<button type="button">Editor</button>}
        path="src/index.ts"
      />,
    );

    expect(header).toContain('<button type="button">Editor</button>');
    expect(header.match(/data-tauri-drag-region/g)).toHaveLength(2);
  });
});
