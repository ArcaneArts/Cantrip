import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  FileChangePreview,
  fileChangePreviewLines,
  filePreviewLanguage,
} from "./file-change-preview";

describe("FileChangePreview", () => {
  it("infers supported source languages from file paths", () => {
    expect(filePreviewLanguage("src/example.tsx")).toBe("tsx");
    expect(filePreviewLanguage("src/main/java/App.java")).toBe("java");
    expect(filePreviewLanguage("README.unknown")).toBeNull();
  });

  it("prefers a bounded diff preview and preserves its line markers", () => {
    expect(
      fileChangePreviewLines({
        path: "src/example.ts",
        kind: "update",
        latestLine: "const current = true;",
        diffPreview: "-const current = false;\n+const current = true;",
      }),
    ).toEqual([
      { code: "const current = false;", marker: "-" },
      { code: "const current = true;", marker: "+" },
    ]);
  });

  it("renders escaped, syntax-highlighted source inside a diff-like gutter", () => {
    const markup = renderToStaticMarkup(
      <FileChangePreview
        changes={[
          {
            path: "src/example.ts",
            kind: "add",
            latestLine: "const html = '<safe>';",
          },
        ]}
      />,
    );

    expect(markup).toContain('data-slot="file-change-preview"');
    expect(markup).toContain('data-language="typescript"');
    expect(markup).toContain('class="token keyword"');
    expect(markup).toContain("&#x27;&lt;safe&gt;&#x27;");
    expect(markup).toContain("text-emerald-500");
  });
});
