import { describe, expect, it } from "vitest";

import { codeEditorTargetUrl } from "../src/code/proxy-utils.js";

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

  it("rejects a non-local generated workspace URI", () => {
    expect(() =>
      codeEditorTargetUrl(
        editorOrigin,
        "/code/",
        "/code",
        "file://remote-worker/private/project.code-workspace",
      ),
    ).toThrow("invalid workspace URI");
  });
});
