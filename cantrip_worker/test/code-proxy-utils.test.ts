import { describe, expect, it } from "vitest";

import {
  codeEditorPublicAuthority,
  codeEditorPublicStartupSelection,
  codeEditorRequestHeaders,
  codeEditorTargetUrl,
} from "../src/code/proxy-utils.js";

describe("Cantrip Code proxy workspace binding", () => {
  const editorOrigin = "http://127.0.0.1:54321";
  const workspaceUri = "file:///worker/authorized/project.code-workspace";

  it("replaces hostile root workspace selectors with the authorized workspace", () => {
    const target = codeEditorTargetUrl(
      editorOrigin,
      "/code/?folder=%2Fworker%2Fother&workspace=%2Fworker%2Fhostile.code-workspace&preserved=yes",
      "/code",
      workspaceUri,
    );

    expect(target.pathname).toBe("/");
    expect(target.searchParams.get("folder")).toBeNull();
    expect(target.searchParams.getAll("workspace")).toEqual([
      "/worker/authorized/project.code-workspace",
    ]);
    expect(target.searchParams.get("preserved")).toBe("yes");
  });

  it("accepts only a well-formed initial file inside the authorized workspace", () => {
    const authorizedPayload = JSON.stringify([
      [
        "openFile",
        "vscode-remote://cantrip.example:8443/worker/authorized/src/example%20file.ts",
      ],
    ]);
    const target = codeEditorTargetUrl(
      editorOrigin,
      `/code/?payload=${encodeURIComponent(
        JSON.stringify([["openFile", "file:///renderer/hostile.ts"]]),
      )}`,
      "/code",
      workspaceUri,
      "file:///worker/authorized/src/example%20file.ts",
      "cantrip.example:8443",
    );

    expect(JSON.parse(target.searchParams.get("payload")!)).toEqual([
      [
        "openFile",
        "vscode-remote://cantrip.example:8443/worker/authorized/src/example%20file.ts",
      ],
    ]);
    expect(
      codeEditorPublicStartupSelection(
        `/code/?payload=${encodeURIComponent(
          JSON.stringify([["openFile", "file:///renderer/hostile.ts"]]),
        )}`,
        "/code",
        workspaceUri,
        "cantrip.example:8443",
      ),
    ).toEqual({ authorized: false });
    expect(
      codeEditorPublicStartupSelection(
        `/code/?payload=${encodeURIComponent(authorizedPayload)}`,
        "/code",
        workspaceUri,
        "cantrip.example:8443",
      ),
    ).toEqual({
      authorized: true,
      initialFileUri: "file:///worker/authorized/src/example%20file.ts",
    });
    expect(
      codeEditorPublicStartupSelection(
        "/code/?workspace=%2Fworker%2Fauthorized%2Fproject.code-workspace",
        "/code",
        workspaceUri,
      ),
    ).toEqual({ authorized: true });
  });

  it("keeps an authorized attachment URL stable when session navigation changes", () => {
    const originalPayload = JSON.stringify([
      [
        "openFile",
        "vscode-remote://cantrip.example/worker/authorized/src/original.ts",
      ],
    ]);
    const rawPath = `/code/?payload=${encodeURIComponent(originalPayload)}`;
    const selection = codeEditorPublicStartupSelection(
      rawPath,
      "/code",
      workspaceUri,
      "cantrip.example",
    );
    expect(selection).toEqual({
      authorized: true,
      initialFileUri: "file:///worker/authorized/src/original.ts",
    });
    if (!selection.authorized || !selection.initialFileUri) {
      throw new Error("Expected an authorized initial file.");
    }
    const target = codeEditorTargetUrl(
      editorOrigin,
      rawPath,
      "/code",
      workspaceUri,
      selection.initialFileUri,
      "cantrip.example",
    );

    expect(target.searchParams.get("payload")).toBe(originalPayload);
  });

  it("removes workspace selectors from nested HTTP and WebSocket routes", () => {
    const target = codeEditorTargetUrl(
      editorOrigin,
      "/code/stable/editor/socket?folder=%2Fworker%2Fother&workspace=%2Fworker%2Fhostile.code-workspace&reconnectionToken=one",
      "/code",
      workspaceUri,
    );

    expect(target.pathname).toBe("/stable/editor/socket");
    expect(target.searchParams.get("folder")).toBeNull();
    expect(target.searchParams.get("workspace")).toBeNull();
    expect(target.searchParams.get("reconnectionToken")).toBe("one");
  });

  it("removes renderer payloads from nested routes", () => {
    const target = codeEditorTargetUrl(
      editorOrigin,
      `/code/stable/editor/socket?payload=${encodeURIComponent(
        JSON.stringify([["openFile", "file:///renderer/hostile.ts"]]),
      )}`,
      "/code",
      workspaceUri,
      "file:///worker/authorized/example.ts",
      "cantrip.example",
    );

    expect(target.searchParams.get("payload")).toBeNull();
  });

  it("rejects a renderer payload when the authorized session has no initial file", () => {
    expect(
      codeEditorPublicStartupSelection(
        `/code/?workspace=%2Fworker%2Fauthorized%2Fproject.code-workspace&payload=${encodeURIComponent(
          JSON.stringify([["openFile", "file:///renderer/hostile.ts"]]),
        )}`,
        "/code",
        workspaceUri,
        "cantrip.example",
      ),
    ).toEqual({ authorized: false });
  });

  it("preserves Windows drive and UNC paths in remote initial-file URIs", () => {
    const drive = codeEditorTargetUrl(
      editorOrigin,
      "/code/?workspace=%2FC%3A%2Fproject.code-workspace",
      "/code",
      "file:///C:/project.code-workspace",
      "file:///C:/project/src/example.ts",
      "cantrip-code.local",
    );
    const unc = codeEditorTargetUrl(
      editorOrigin,
      "/code/?workspace=%2F%2Fserver%2Fshare%2Fproject.code-workspace",
      "/code",
      "file://server/share/project.code-workspace",
      "file://server/share/src/example.ts",
      "cantrip-code.local",
    );

    expect(JSON.parse(drive.searchParams.get("payload")!)).toEqual([
      [
        "openFile",
        "vscode-remote://cantrip-code.local/C:/project/src/example.ts",
      ],
    ]);
    expect(JSON.parse(unc.searchParams.get("payload")!)).toEqual([
      [
        "openFile",
        "vscode-remote://cantrip-code.local//server/share/src/example.ts",
      ],
    ]);
  });

  it("rejects a non-file generated workspace URI", () => {
    expect(() =>
      codeEditorTargetUrl(
        editorOrigin,
        "/code/",
        "/code",
        "https://remote-worker/private/project.code-workspace",
      ),
    ).toThrow("invalid workspace URI");
  });

  it("rejects an initial file without a canonical public authority", () => {
    expect(() =>
      codeEditorTargetUrl(
        editorOrigin,
        "/code/",
        "/code",
        workspaceUri,
        "file:///worker/authorized/example.ts",
      ),
    ).toThrow("public editor authority");
  });
});

describe("Cantrip Code proxy authority binding", () => {
  it("derives the authority only from Host and replaces spoofed proxy headers", () => {
    const input: Array<[string, string]> = [
      ["Host", "Cantrip.Example:8443"],
      ["X-Original-Host", "attacker.example"],
      ["X-Forwarded-Host", "attacker.example"],
      ["X-Forwarded-Port", "666"],
    ];
    const target = new URL("http://127.0.0.1:54321/");
    const headers = codeEditorRequestHeaders(input, target, "/code", "secret");

    expect(codeEditorPublicAuthority(input)).toBe("cantrip.example:8443");
    expect(headers["x-original-host"]).toBeUndefined();
    expect(headers["x-forwarded-host"]).toBe("cantrip.example:8443");
    expect(headers["x-forwarded-port"]).toBeUndefined();
  });
});
