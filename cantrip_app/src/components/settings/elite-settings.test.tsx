import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EliteSettings } from "./elite-settings";

describe("Elite settings laboratory", () => {
  it("renders the replay controls and each fixture view selector", () => {
    const markup = renderToStaticMarkup(<EliteSettings />);

    expect(markup).toContain("Elite reveal laboratory");
    expect(markup).toContain("Replay</button>");
    expect(markup).toContain("Configure</button>");
    expect(markup).toContain("List</button>");
    expect(markup).toContain("Cards</button>");
    expect(markup).toContain("Text</button>");
    expect(markup).toContain("Table</button>");
    expect(markup).toContain("Widgets</button>");
  });

  it("marks fixture items with explicit reveal semantics", () => {
    const markup = renderToStaticMarkup(<EliteSettings />);

    expect(markup).toContain('data-elite-reveal=""');
    expect(markup).toContain('data-content-kind="box"');
    expect(markup).toContain('data-state="waiting"');
    expect(markup).toContain("Relay subsystem 01");
  });
});
