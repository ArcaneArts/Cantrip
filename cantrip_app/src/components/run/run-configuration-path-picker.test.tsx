import type { RunConfigurationPathSuggestion } from "@cantrip/protocol/run-configuration-definitions";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RunConfigurationPathPickerList } from "./run-configuration-path-picker";

const suggestions: RunConfigurationPathSuggestion[] = [
  { kind: "directory", path: "packages/api" },
  { kind: "file", path: "packages/api/src/index.ts" },
];

describe("Run configuration path picker", () => {
  it("renders searchable typed paths and marks the current value", () => {
    const html = renderToStaticMarkup(
      <RunConfigurationPathPickerList
        currentPath="packages/api/src/index.ts"
        error={null}
        fetching={false}
        onChoose={vi.fn()}
        onQueryChange={vi.fn()}
        query="api"
        suggestions={suggestions}
        truncated={false}
      />,
    );

    expect(html).toContain("Search project paths");
    expect(html).toContain("packages/api");
    expect(html).toContain("packages/api/src/index.ts");
    expect(html).toContain("text-emerald-600");
  });

  it("shows bounded discovery progress, empty results, and truncation", () => {
    const loading = renderToStaticMarkup(
      <RunConfigurationPathPickerList
        currentPath=""
        error={null}
        fetching
        onChoose={vi.fn()}
        onQueryChange={vi.fn()}
        query=""
        suggestions={[]}
        truncated={false}
      />,
    );
    expect(loading).toContain("Searching project paths");

    const bounded = renderToStaticMarkup(
      <RunConfigurationPathPickerList
        currentPath=""
        error={null}
        fetching={false}
        onChoose={vi.fn()}
        onQueryChange={vi.fn()}
        query="missing"
        suggestions={[]}
        truncated
      />,
    );
    expect(bounded).toContain("No matching project paths");
    expect(bounded).toContain("Showing the first 100 matches");
  });
});
