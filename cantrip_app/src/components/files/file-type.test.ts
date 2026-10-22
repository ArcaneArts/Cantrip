import { describe, expect, it } from "vitest";
import { fileIconKindForPath } from "./file-type";
import { fileIconExamples } from "./file-type-fixtures";

describe("filename icons", () => {
  it.each(fileIconExamples)(
    "uses the %s filename to select %s",
    (path, kind) => {
      expect(fileIconKindForPath(path)).toBe(kind);
    },
  );
  it.each([
    "/repo/src/LIB.RS",
    "C:\\repo\\src\\LIB.RS",
    "\\\\host\\share\\LIB.RS",
  ])("uses the basename and ignores case on every host: %s", (path) =>
    expect(fileIconKindForPath(path)).toBe("rust"),
  );
  it.each([
    "",
    "README.custom",
    ".rs",
    ".unknown",
    "directory.rs/no-extension",
    "directory.json/",
    "toString",
    "constructor",
    "__proto__",
    "file.constructor",
  ])("safely falls back for unknown or special names: %s", (path) =>
    expect(fileIconKindForPath(path)).toBe("file"),
  );
});
