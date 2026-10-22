import { describe, expect, it } from "vitest";

import {
  defaultExplorerFileMode,
  markdownPreviewUsesPlainText,
  textLanguageForPath,
  structuredFileFormatForPath,
} from "./explorer-file-language";

describe("explorer file editing", () => {
  it("maps viewable source files to text languages", () => {
    expect(textLanguageForPath("src/App.tsx")).toBe("typescript");
    expect(textLanguageForPath("Dockerfile")).toBe("dockerfile");
    expect(textLanguageForPath("contracts/Token.sol")).toBe("sol");
    expect(textLanguageForPath("scripts/setup.ps1")).toBe("powershell");
    expect(textLanguageForPath("Cantrip.csproj")).toBe("xml");
    expect(textLanguageForPath("Cantrip.sln")).toBe("plaintext");
    expect(textLanguageForPath("build.cmd")).toBe("bat");
    expect(textLanguageForPath("assets/photo.png")).toBeNull();
    expect(textLanguageForPath("assets/logo.svg")).toBeNull();
  });

  it("opens editable files in the editor and falls back to preview", () => {
    expect(defaultExplorerFileMode("package.json")).toBe("edit");
    expect(defaultExplorerFileMode("Cargo.toml")).toBe("edit");
    expect(defaultExplorerFileMode("compose.yaml")).toBe("edit");
    expect(defaultExplorerFileMode("workflow.YML")).toBe("edit");
    expect(defaultExplorerFileMode("data.csv")).toBe("edit");
    expect(defaultExplorerFileMode("gradle.properties")).toBe("edit");
    expect(defaultExplorerFileMode(".env")).toBe("edit");
    expect(defaultExplorerFileMode("scripts/setup.ps1")).toBe("edit");
    expect(defaultExplorerFileMode("Cantrip.csproj")).toBe("edit");
    expect(defaultExplorerFileMode("README.md")).toBe("preview");
    expect(defaultExplorerFileMode("docs/guide.mdx")).toBe("preview");
    expect(defaultExplorerFileMode("unrecognized.extension")).toBe("edit");
    expect(defaultExplorerFileMode("ChangeLog.txt")).toBe("edit");
    expect(defaultExplorerFileMode("assets/photo.png")).toBe("preview");
    expect(defaultExplorerFileMode("recording.mp4")).toBe("preview");
    expect(defaultExplorerFileMode("LICENSE")).toBe("preview");
    expect(defaultExplorerFileMode("LICENSE.md")).toBe("preview");
    expect(defaultExplorerFileMode("COPYING.GPL")).toBe("preview");
    expect(defaultExplorerFileMode("build.gradle")).toBe("edit");
    expect(defaultExplorerFileMode("gradlew.bat")).toBe("edit");
  });

  it("keeps plain-text license documents out of Markdown code-block parsing", () => {
    expect(markdownPreviewUsesPlainText("LICENSE.md")).toBe(true);
    expect(markdownPreviewUsesPlainText("licenses/COPYING.GPL.md")).toBe(true);
    expect(markdownPreviewUsesPlainText("README.md")).toBe(false);
    expect(markdownPreviewUsesPlainText("docs/license-guide.md")).toBe(false);
    expect(markdownPreviewUsesPlainText("LICENSE.txt")).toBe(false);
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
});
