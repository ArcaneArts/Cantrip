import { describe, expect, it } from "vitest";

import {
  displayMarkdownFileReference,
  markdownFileLinkUrlTransform,
  markdownFilePathFromHref,
  markdownFileReference,
  markdownFileReferences,
  projectFilePath,
} from "./markdown-file-link";

describe("Markdown file links", () => {
  it("preserves Windows file destinations behind an internal link scheme", () => {
    const href = markdownFileLinkUrlTransform(
      "E:%5Cworkspace%5CMC%20MDK%5CFabric%5Cbuild%5Clibs%5Cfabric.jar",
    );

    expect(href).toMatch(/^#cantrip-file=/);
    expect(markdownFilePathFromHref(href)).toBe(
      "E:\\workspace\\MC MDK\\Fabric\\build\\libs\\fabric.jar",
    );
  });

  it("decodes file URLs while leaving web URLs alone", () => {
    expect(markdownFileReference("file:///E:/workspace/build/app.jar")).toBe(
      "E:/workspace/build/app.jar",
    );
    expect(markdownFileReference("https://example.com/release")).toBeNull();
    expect(markdownFileLinkUrlTransform("https://example.com/release")).toBe(
      "https://example.com/release",
    );
  });

  it("resolves absolute Windows paths inside the active worktree", () => {
    expect(
      projectFilePath(
        "E:\\workspace\\MC MDK\\Fabric\\build\\libs\\fabric.jar",
        "E:\\workspace\\MC MDK\\Fabric",
      ),
    ).toBe("build/libs/fabric.jar");
  });

  it("resolves POSIX, relative, and source-location file links", () => {
    expect(
      projectFilePath(
        "file:///srv/repos/cantrip/src/App.tsx#L593C4",
        "/srv/repos/cantrip",
      ),
    ).toBe("src/App.tsx");
    expect(projectFilePath("./src/App.tsx:593:4", "/srv/repos/cantrip")).toBe(
      "src/App.tsx",
    );
  });

  it("rejects links outside the active worktree and relative escapes", () => {
    expect(
      projectFilePath("C:\\Windows\\system.ini", "E:\\workspace\\repo"),
    ).toBeNull();
    expect(
      projectFilePath("../../secret.txt", "/srv/repos/cantrip"),
    ).toBeNull();
  });

  it("extracts file links from Markdown while ignoring web links", () => {
    expect(
      markdownFileReferences(
        "See [README](</srv/repos/My Project/README.md:12>) and [source](./src/main.ts#L4C2), not [the docs](https://example.com/docs).",
      ),
    ).toEqual(["/srv/repos/My Project/README.md:12", "./src/main.ts#L4C2"]);
    expect(
      displayMarkdownFileReference("/srv/repos/My Project/README.md:12"),
    ).toBe("/srv/repos/My Project/README.md");
  });

  it("resolves safe relative links without requiring a hydrated root path", () => {
    expect(projectFilePath("./src/App.tsx:12", null)).toBe("src/App.tsx");
    expect(projectFilePath("/srv/repos/cantrip/src/App.tsx", null)).toBeNull();
  });
});
