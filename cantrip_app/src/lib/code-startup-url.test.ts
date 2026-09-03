import { describe, expect, it } from "vitest";

import { configureCodeStartupUrl } from "@/lib/code-startup-url";

describe("configureCodeStartupUrl", () => {
  it("adds the authorized workspace and initial file for a direct attachment", () => {
    const url = configureCodeStartupUrl(
      new URL("http://127.0.0.1:4310/code/"),
      {
        workspaceUri: "file:///worker/project.code-workspace",
        initialFileUri: "file:///worker/src/example%20file.ts",
      },
      "127.0.0.1:4310",
    );

    expect(url.searchParams.get("workspace")).toBe(
      "/worker/project.code-workspace",
    );
    expect(JSON.parse(url.searchParams.get("payload")!)).toEqual([
      [
        "openFile",
        "vscode-remote://127.0.0.1:4310/worker/src/example%20file.ts",
      ],
    ]);
  });

  it("preserves Windows drive and UNC paths", () => {
    const drive = configureCodeStartupUrl(
      new URL("https://cantrip.example/__cantrip_code/adapter/code/"),
      {
        workspaceUri: "file:///C:/project/project.code-workspace",
        initialFileUri: "file:///C:/project/src/example.ts",
      },
      "cantrip-code.local",
    );
    const unc = configureCodeStartupUrl(
      new URL("https://cantrip.example/__cantrip_code/adapter/code/"),
      {
        workspaceUri: "file://server/share/project.code-workspace",
        initialFileUri: "file://server/share/src/example.ts",
      },
      "cantrip-code.local",
    );

    expect(drive.searchParams.get("workspace")).toBe(
      "/C:/project/project.code-workspace",
    );
    expect(JSON.parse(drive.searchParams.get("payload")!)).toEqual([
      [
        "openFile",
        "vscode-remote://cantrip-code.local/C:/project/src/example.ts",
      ],
    ]);
    expect(unc.searchParams.get("workspace")).toBe(
      "//server/share/project.code-workspace",
    );
    expect(JSON.parse(unc.searchParams.get("payload")!)).toEqual([
      [
        "openFile",
        "vscode-remote://cantrip-code.local//server/share/src/example.ts",
      ],
    ]);
  });
});
