// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { VisualFileFormat } from "./explorer-file-language";
import { StructuredFileVisual } from "./structured-file-visual";

describe("StructuredFileVisual", () => {
  it.each<[VisualFileFormat, string]>([
    ["json", '{"name":"Cantrip"}'],
    ["toml", 'name = "Cantrip"'],
    ["yaml", "name: Cantrip"],
    ["csv", "name\nCantrip\n"],
    ["env", "NAME=Cantrip\n"],
    ["properties", "name=Cantrip\n"],
  ])(
    "uses opt-in gutters and a transparent search/status bar for %s",
    (format, content) => {
      const root = document.createElement("div");
      root.innerHTML = renderToStaticMarkup(
        <StructuredFileVisual
          content={content}
          format={format}
          onChange={vi.fn()}
          onSave={vi.fn()}
          path={`example.${format}`}
        />,
      );
      const viewport = root.querySelector('[data-content-gutter="standard"]');
      expect(viewport).not.toBeNull();
      expect(viewport!.className).toContain("overflow-auto");
      expect(
        viewport!.className
          .split(/\s+/u)
          .some((name) => /^(?:p-|px-|pl-|pr-)/u.test(name)),
      ).toBe(false);
      const table = viewport!.querySelector('[role="table"], table')!;
      expect(table).not.toBeNull();
      expect(table.parentElement!.className).not.toMatch(
        /\b(?:mx-auto|max-w-6xl)\b/u,
      );
      expect(table.className).not.toMatch(/\b(?:mx-auto|max-w-6xl)\b/u);
      const toolbar = root.querySelector('[data-slot="file-visual-toolbar"]');
      expect(toolbar).not.toBeNull();
      expect(toolbar!.className).not.toMatch(/\b(?:bg-|backdrop-blur)/u);
    },
  );

  it("renders searchable value-only rows and expandable sections", () => {
    const markup = renderToStaticMarkup(
      <StructuredFileVisual
        content={'{"name":"Cantrip","scripts":{"test":"vitest"}}'}
        format="json"
        onChange={vi.fn()}
        onSave={vi.fn()}
        path="package.json"
      />,
    );

    expect(markup).toContain('aria-label="Search structured values"');
    expect(markup).toContain("Values only · keys and structure are locked");
    expect(markup).toContain('aria-label="Edit name"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('data-elite-ignore=""');
    expect(markup).toContain("scripts");
  });

  it("explains how to repair invalid structured source", () => {
    const markup = renderToStaticMarkup(
      <StructuredFileVisual
        content="{invalid"
        format="json"
        onChange={vi.fn()}
        onSave={vi.fn()}
        path="broken.json"
      />,
    );

    expect(markup).toContain("Visual mode is unavailable");
    expect(markup).toContain("Switch to Edit to repair the document");
  });

  it("renders Gradle-templated TOML dependency tables", () => {
    const markup = renderToStaticMarkup(
      <StructuredFileVisual
        content={[
          "# Dependencies are optional.",
          "[[dependencies.${mod_id}]] #optional",
          'modId = "forge"',
          "mandatory = true",
          "",
        ].join("\n")}
        format="toml"
        onChange={vi.fn()}
        onSave={vi.fn()}
        path="mods.toml"
      />,
    );

    expect(markup).not.toContain("Visual mode is unavailable");
    expect(markup).toContain("dependencies");
    expect(markup).toContain("2 editable values");
  });

  it("renders CSV with locked headers and editable body cells", () => {
    const markup = renderToStaticMarkup(
      <StructuredFileVisual
        content={"name,email\nCantrip,hello@cantrip.app\n"}
        format="csv"
        onChange={vi.fn()}
        onSave={vi.fn()}
        path="people.csv"
      />,
    );

    expect(markup).toContain('aria-label="Search rows"');
    expect(markup).toContain(
      "Cells only · headers, rows, and columns are locked",
    );
    expect(markup).toContain("name");
    expect(markup).toContain('aria-label="Edit row 2, name"');
    expect(markup).not.toContain("Add property");
  });

  it("renders editable dotenv properties with an add-variable action", () => {
    const markup = renderToStaticMarkup(
      <StructuredFileVisual
        content={"PORT=3000\n"}
        format="env"
        onChange={vi.fn()}
        onSave={vi.fn()}
        path=".env"
      />,
    );

    expect(markup).toContain('aria-label="Search variables"');
    expect(markup).toContain(
      "Keys and values are editable · comments are preserved",
    );
    expect(markup).toContain("Add variable");
    expect(markup).toContain('aria-label="Edit variable name PORT"');
  });
});
