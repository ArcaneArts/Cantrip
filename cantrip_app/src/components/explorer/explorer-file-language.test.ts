import { describe, expect, it } from "vitest";

import {
  defaultExplorerFileMode,
  monacoLanguageForPath,
  monacoModelPath,
  structuredFileFormatForPath,
} from "./explorer-file-language";

describe("explorer file editing", () => {
  it("maps viewable source files to Monaco languages", () => {
    expect(monacoLanguageForPath("src/App.tsx")).toBe("typescript");
    expect(monacoLanguageForPath("Dockerfile")).toBe("dockerfile");
    expect(monacoLanguageForPath("contracts/Token.sol")).toBe("sol");
    expect(monacoLanguageForPath("assets/photo.png")).toBeNull();
    expect(monacoLanguageForPath("assets/logo.svg")).toBeNull();
  });

  it("opens structured files visually and other files in preview mode", () => {
    expect(defaultExplorerFileMode("package.json")).toBe("visual");
    expect(defaultExplorerFileMode("Cargo.toml")).toBe("visual");
    expect(defaultExplorerFileMode("compose.yaml")).toBe("visual");
    expect(defaultExplorerFileMode("workflow.YML")).toBe("visual");
    expect(defaultExplorerFileMode("data.csv")).toBe("visual");
    expect(defaultExplorerFileMode("gradle.properties")).toBe("visual");
    expect(defaultExplorerFileMode(".env")).toBe("visual");
    expect(defaultExplorerFileMode("README.md")).toBe("preview");
    expect(defaultExplorerFileMode("assets/photo.png")).toBe("preview");
    expect(defaultExplorerFileMode("recording.mp4")).toBe("preview");
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
