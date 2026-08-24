import { describe, expect, it, vi } from "vitest";

import {
  configureExplorerCodeEditorNavigation,
  ExplorerCodePresentationCache,
  explorerCodeEditorBindingKey,
  explorerCodeEditorOpenRecovery,
  explorerCodeEditorReadyKey,
} from "./explorer-code-editor";
import { codeWorkbenchStageError } from "@/lib/code-workbench-frame";
import { CodeControlOperationTimeoutError } from "@/lib/desktop-code";

function binding(
  overrides: Partial<Parameters<typeof explorerCodeEditorBindingKey>[0]> = {},
) {
  return explorerCodeEditorBindingKey({
    appearance: "dark",
    explorerId: "explorer-one",
    reloadVersion: 0,
    workerId: "worker-one",
    worktreeId: "worktree-one",
    ...overrides,
  });
}

describe("Explorer Code editor readiness identity", () => {
  it("retains readiness only for the acknowledged attachment and path", () => {
    const currentBinding = binding();
    const acknowledged = explorerCodeEditorReadyKey(
      "attachment-one",
      "src/first.ts",
      currentBinding,
    );

    expect(
      explorerCodeEditorReadyKey(
        "attachment-one",
        "src/first.ts",
        currentBinding,
      ),
    ).toBe(acknowledged);
    expect(
      explorerCodeEditorReadyKey(
        "attachment-one",
        "src/second.ts",
        currentBinding,
      ),
    ).not.toBe(acknowledged);
    expect(
      explorerCodeEditorReadyKey(
        "attachment-two",
        "src/first.ts",
        currentBinding,
      ),
    ).not.toBe(acknowledged);
  });

  it("invalidates readiness when worktree, worker, or reload changes", () => {
    const current = binding();

    expect(binding({ worktreeId: "worktree-two" })).not.toBe(current);
    expect(binding({ workerId: "worker-two" })).not.toBe(current);
    expect(binding({ reloadVersion: 1 })).not.toBe(current);
  });
});

describe("Explorer Code editor navigation", () => {
  it("does not rebuild the attachment after a bounded control timeout retry", () => {
    const timeout = codeWorkbenchStageError(
      "file",
      new CodeControlOperationTimeoutError(),
    );

    expect(explorerCodeEditorOpenRecovery(timeout, 0, 0)).toBe("retry");
    expect(explorerCodeEditorOpenRecovery(timeout, 1, 0)).toBe("error");
    expect(
      explorerCodeEditorOpenRecovery(new TypeError("Load failed"), 0, 0),
    ).toBe("retry");
    expect(
      explorerCodeEditorOpenRecovery(new TypeError("Load failed"), 1, 0),
    ).toBe("reload");
  });

  it("caches successful presentation for file switches and file retries", async () => {
    const presentation = new ExplorerCodePresentationCache();
    const setPresentation = vi.fn(async () => undefined);
    const openFile = vi
      .fn<(path: string) => Promise<{ relativePath: string }>>()
      .mockImplementationOnce(async () => {
        throw new TypeError("Load failed");
      })
      .mockImplementation(async (path) => ({ relativePath: path }));
    const signal = new AbortController().signal;

    await expect(
      configureExplorerCodeEditorNavigation({
        frameNonce: "frame_nonce_one_1234567890",
        openFile: () => openFile("src/a.ts"),
        presentation,
        setPresentation,
        signal,
      }),
    ).rejects.toThrow("Load failed");
    await expect(
      configureExplorerCodeEditorNavigation({
        frameNonce: "frame_nonce_one_1234567890",
        openFile: () => openFile("src/a.ts"),
        presentation,
        setPresentation,
        signal,
      }),
    ).resolves.toEqual({ relativePath: "src/a.ts" });
    await expect(
      configureExplorerCodeEditorNavigation({
        frameNonce: "frame_nonce_one_1234567890",
        openFile: () => openFile("src/b.ts"),
        presentation,
        setPresentation,
        signal,
      }),
    ).resolves.toEqual({ relativePath: "src/b.ts" });

    expect(setPresentation).toHaveBeenCalledOnce();
    expect(openFile).toHaveBeenCalledTimes(3);
  });

  it("replays presentation once for a new authenticated frame nonce", async () => {
    const presentation = new ExplorerCodePresentationCache();
    const setPresentation = vi.fn(async () => undefined);
    const signal = new AbortController().signal;
    const configure = (frameNonce: string) =>
      configureExplorerCodeEditorNavigation({
        frameNonce,
        openFile: async () => ({ relativePath: "src/current.ts" }),
        presentation,
        setPresentation,
        signal,
      });

    await configure("frame_nonce_one_1234567890");
    await configure("frame_nonce_one_1234567890");
    await configure("frame_nonce_two_1234567890");
    await configure("frame_nonce_two_1234567890");

    expect(setPresentation).toHaveBeenCalledTimes(2);
  });
});
