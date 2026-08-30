import { describe, expect, it } from "vitest";

import {
  explorerMarkdownFileForPath,
  explorerTextFileForPath,
  explorerTextLanguageForPath,
} from "../src/index.js";

describe("Explorer text file classification", () => {
  it("classifies PowerShell and common Windows project files as editable text", () => {
    expect(explorerTextLanguageForPath("scripts/setup.ps1")).toBe("powershell");
    expect(explorerTextLanguageForPath("Modules/Cantrip.psm1")).toBe(
      "powershell",
    );
    expect(explorerTextLanguageForPath("Cantrip.csproj")).toBe("xml");
    expect(explorerTextLanguageForPath("Cantrip.sln")).toBe("plaintext");
    expect(explorerTextLanguageForPath("build.cmd")).toBe("bat");
  });

  it("shares text and Markdown classification across path conventions", () => {
    expect(explorerTextFileForPath("C:\\repo\\scripts\\deploy.ps1")).toBe(true);
    expect(explorerMarkdownFileForPath("docs/guide.mdx")).toBe(true);
    expect(explorerTextFileForPath("assets/logo.png")).toBe(false);
  });
});
