import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApplicationLoadingSplash } from "./application-loading-splash";

describe("ApplicationLoadingSplash", () => {
  it("shows the shimmering bolt while the session loads", () => {
    const markup = renderToStaticMarkup(<ApplicationLoadingSplash />);

    expect(markup).toContain("data-application-loading-splash");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-label="Loading Cantrip…"');
    expect(markup).toContain("cantrip-loading__mark");
    expect(markup).toContain("cantrip-loading__shimmer");
    expect(markup).not.toContain("data-elite-reveal");
    expect(markup).not.toContain("New project");
  });
});
