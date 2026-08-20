import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NativeSelect } from "./native-select";

describe("NativeSelect", () => {
  it("renders shared interaction styling and native select behavior", () => {
    const markup = renderToStaticMarkup(
      <NativeSelect aria-label="Scope" defaultValue="all" size="sm">
        <option value="all">All</option>
      </NativeSelect>,
    );

    expect(markup).toContain('data-slot="native-select"');
    expect(markup).toContain('aria-label="Scope"');
    expect(markup).toContain("h-8");
    expect(markup).toContain("focus-visible:ring-[3px]");
    expect(markup).toContain('<option value="all" selected="">All</option>');
  });

  it("merges consumer layout classes over variant defaults", () => {
    const markup = renderToStaticMarkup(
      <NativeSelect
        aria-label="Compact scope"
        className="h-7 w-full bg-transparent"
        size="sm"
      />,
    );

    expect(markup).toContain("h-7");
    expect(markup).not.toContain("h-8");
    expect(markup).toContain("w-full");
    expect(markup).toContain("bg-transparent");
  });
});
