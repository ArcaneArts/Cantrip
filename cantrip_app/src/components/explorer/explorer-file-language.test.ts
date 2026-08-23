import { describe, expect, it } from "vitest";

import {
  defaultExplorerFileMode,
  monacoLanguageForPath,
  monacoModelPath,
  structuredFileFormatForPath,
  usesCantripCodeEditor,
} from "./explorer-file-language";

describe("explorer file editing", () => {
  it("maps viewable source files to Monaco languages", () => {
    expect(monacoLanguageForPath("src/App.tsx")).toBe("typescript");
    expect(monacoLanguageForPath("Dockerfile")).toBe("dockerfile");
    expect(monacoLanguageForPath("contracts/Token.sol")).toBe("sol");
    expect(monacoLanguageForPath("assets/photo.png")).toBeNull();
    expect(monacoLanguageForPath("assets/logo.svg")).toBeNull();
  });

  it("opens editable files in the editor and falls back to preview", () => {
    expect(defaultExplorerFileMode("package.json")).toBe("edit");
    expect(defaultExplorerFileMode("Cargo.toml")).toBe("edit");
    expect(defaultExplorerFileMode("compose.yaml")).toBe("edit");
    expect(defaultExplorerFileMode("workflow.YML")).toBe("edit");
    expect(defaultExplorerFileMode("data.csv")).toBe("edit");
    expect(defaultExplorerFileMode("gradle.properties")).toBe("edit");
    expect(defaultExplorerFileMode(".env")).toBe("edit");
    expect(defaultExplorerFileMode("README.md")).toBe("preview");
    expect(defaultExplorerFileMode("docs/guide.mdx")).toBe("preview");
    expect(defaultExplorerFileMode("ChangeLog.txt")).toBe("edit");
    expect(defaultExplorerFileMode("assets/photo.png")).toBe("preview");
    expect(defaultExplorerFileMode("recording.mp4")).toBe("preview");
  });

  it("routes edit mode through Cantrip Code", () => {
    expect(usesCantripCodeEditor("build.gradle.kts", "edit")).toBe(true);
    expect(usesCantripCodeEditor("ChangeLog.txt", "edit")).toBe(true);
    expect(usesCantripCodeEditor("README.md", "edit")).toBe(true);
    expect(usesCantripCodeEditor("README.md", "preview")).toBe(false);
    expect(usesCantripCodeEditor("assets/photo.png", "edit")).toBe(false);
  });

  it("identifies supported structured file formats", () => {
    expect(structuredFileFormatForPath("package.json")).toBe("json");
    expect(structuredFileFormatForPath("Cargo.toml")).toBe("toml");
    expect(structuredFileFormatForPath("compose.yml")).toBe("yaml");
    expect(structuredFileFormatForPath("people.csv")).toBe("csv");
    expect(structuredFileFormatForPath("gradle.properties")).toBe("properties");
    expect(structuredFileFormatForPath(".env")).toBe("env");
    expect(structuredFileFormatForPath("src/App.tsx")).toBeNull();
  });

  it("uses collision-safe Monaco model paths", () => {
    expect(monacoModelPath("explorer one", "src/a #1.ts")).toBe(
      "cantrip://explorer/explorer%20one/src/a%20%231.ts",
    );
  });
});
