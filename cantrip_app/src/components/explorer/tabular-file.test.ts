import { describe, expect, it } from "vitest";

import {
  appendPropertyEntry,
  parseCsvFile,
  parsePropertyFile,
  updateCsvCell,
  updatePropertyEntry,
} from "./tabular-file";

describe("tabular Explorer files", () => {
  it("parses quoted CSV values and edits cells without changing its headers or shape", () => {
    const content =
      '"name","notes"\r\nCantrip,"fast, focused"\r\nCodex,"line 1\r\nline 2"\r\n';
    const parsed = parseCsvFile(content);

    expect(parsed.headers).toEqual(["name", "notes"]);
    expect(parsed.rows).toEqual([
      ["Cantrip", "fast, focused"],
      ["Codex", "line 1\r\nline 2"],
    ]);

    const updated = updateCsvCell(content, 0, 1, 'clear, "quick"');
    const reparsed = parseCsvFile(updated);
    expect(reparsed.headers).toEqual(parsed.headers);
    expect(reparsed.rows).toHaveLength(2);
    expect(reparsed.rows[0]).toEqual(["Cantrip", 'clear, "quick"']);
    expect(updated.startsWith('"name","notes"\r\n')).toBe(true);
    expect(updated.endsWith("\r\n")).toBe(true);
  });

  it("rejects CSV edits when rows do not match the locked header structure", () => {
    expect(() => parseCsvFile("name,email\nCantrip\n")).toThrow(
      "CSV row 2 has 1 columns; the header has 2",
    );
    expect(() => parseCsvFile('name\n"unterminated')).toThrow(
      "unterminated quoted field",
    );
  });

  it("edits Java properties while preserving comments and unrelated formatting", () => {
    const content = "# build settings\napp.name : Cantrip\npath=C:\\\\work\n";
    const updated = updatePropertyEntry(
      content,
      "properties",
      0,
      "value",
      "Cantrip App",
    );

    expect(updated).toBe(
      "# build settings\napp.name : Cantrip App\npath=C:\\\\work\n",
    );
    expect(parsePropertyFile(updated, "properties").entries).toEqual([
      expect.objectContaining({ key: "app.name", value: "Cantrip App" }),
      expect.objectContaining({ key: "path", value: "C:\\work" }),
    ]);
  });

  it("edits dotenv values without discarding export prefixes or comments", () => {
    const content =
      'export API_URL = "https://old.test" # public endpoint\nDEBUG=false\n';
    const updated = updatePropertyEntry(
      content,
      "env",
      0,
      "value",
      "https://cantrip.app/api",
    );

    expect(updated).toBe(
      'export API_URL = "https://cantrip.app/api" # public endpoint\nDEBUG=false\n',
    );
    expect(parsePropertyFile(updated, "env").entries[0]).toEqual(
      expect.objectContaining({
        key: "API_URL",
        value: "https://cantrip.app/api",
      }),
    );
  });

  it("adds properties and variables without allowing duplicate or invalid keys", () => {
    expect(
      appendPropertyEntry("# settings\n", "properties", "theme", "dark"),
    ).toBe("# settings\ntheme=dark\n");
    expect(
      appendPropertyEntry(
        "PORT=3000",
        "env",
        "PUBLIC_URL",
        "https://cantrip.app",
      ),
    ).toBe("PORT=3000\nPUBLIC_URL=https://cantrip.app");
    expect(() =>
      appendPropertyEntry("PORT=3000", "env", "PORT", "4000"),
    ).toThrow("already exists");
    expect(() => appendPropertyEntry("", "env", "INVALID-NAME", "x")).toThrow(
      "valid environment variable name",
    );
  });
});
