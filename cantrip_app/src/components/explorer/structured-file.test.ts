import { describe, expect, it } from "vitest";

import {
  coerceStructuredScalar,
  countStructuredSearchMatches,
  parseStructuredFile,
  structuredValueMatches,
  updateStructuredFileContent,
  updateStructuredValue,
} from "./structured-file";

describe("structured Explorer files", () => {
  it("updates JSON values without changing keys or collection structure", () => {
    const content =
      '{\n  "name": "cantrip",\n  "nested": {\n    "enabled": true\n  }\n}\n';
    const updated = updateStructuredFileContent(
      content,
      "json",
      ["nested", "enabled"],
      false,
    );

    expect(updated).toBe(
      '{\n  "name": "cantrip",\n  "nested": {\n    "enabled": false\n  }\n}\n',
    );
    expect(parseStructuredFile(updated, "json")).toEqual({
      name: "cantrip",
      nested: { enabled: false },
    });
  });

  it("preserves YAML comments while updating an existing value", () => {
    const content =
      "# deployment settings\nservice:\n  # public port\n  port: 3000\n";
    const updated = updateStructuredFileContent(
      content,
      "yaml",
      ["service", "port"],
      4173,
    );

    expect(updated).toContain("# deployment settings");
    expect(updated).toContain("# public port");
    expect(updated).toContain("port: 4173");
    expect(parseStructuredFile(updated, "yaml")).toEqual({
      service: { port: 4173 },
    });
  });

  it("parses and rewrites TOML tables through the same value path model", () => {
    const content = '[package]\nname = "demo"\npublish = false\n';
    const updated = updateStructuredFileContent(
      content,
      "toml",
      ["package", "publish"],
      true,
    );

    expect(parseStructuredFile(updated, "toml")).toEqual({
      package: { name: "demo", publish: true },
    });
  });

  it("searches nested keys, paths, types, and scalar values", () => {
    const value = {
      database: { host: "localhost", port: 5432 },
      feature: { enabled: true },
    };

    expect(
      structuredValueMatches(value.database, "database", ["database"], "5432"),
    ).toBe(true);
    expect(countStructuredSearchMatches(value, "feature")).toBe(1);
    expect(countStructuredSearchMatches(value, "number")).toBe(1);
    expect(countStructuredSearchMatches(value, "missing")).toBe(0);
  });

  it("coerces scalar edits while rejecting structural path changes", () => {
    expect(coerceStructuredScalar("42", 1)).toBe(42);
    expect(coerceStructuredScalar("false", null)).toBe(false);
    expect(() => coerceStructuredScalar("not-a-number", 1)).toThrow(
      "Enter a finite number.",
    );
    expect(() =>
      updateStructuredValue({ stable: true }, ["renamed"], false),
    ).toThrow("The selected value no longer exists.");
  });
});
