import { describe, expect, it } from "vitest";

import {
  defaultExplorerFileMode,
  monacoLanguageForPath,
  monacoModelPath,
} from "./explorer-file-language";

describe("explorer file editing", () => {
  it("maps viewable source files to Monaco languages", () => {
    expect(monacoLanguageForPath("src/App.tsx")).toBe("typescript");
    expect(monacoLanguageForPath("Dockerfile")).toBe("dockerfile");
    expect(monacoLanguageForPath("contracts/Token.sol")).toBe("sol");
    expect(monacoLanguageForPath("assets/photo.png")).toBeNull();
  });

  it("opens markdown in preview and source files in edit mode", () => {
    expect(defaultExplorerFileMode("README.md", true)).toBe("preview");
    expect(defaultExplorerFileMode("src/index.ts", false)).toBe("edit");
    expect(defaultExplorerFileMode("unknown.bin", false)).toBe("preview");
  });

  it("uses collision-safe Monaco model paths", () => {
    expect(monacoModelPath("explorer one", "src/a #1.ts")).toBe(
      "cantrip://explorer/explorer%20one/src/a%20%231.ts",
    );
  });
});
