import { describe, expect, it, vi } from "vitest";

import {
  configureExplorerCodeEditorNavigation,
  ExplorerCodePresentationCache,
  explorerCodeEditorBindingKey,
  explorerCodeEditorOpenRecovery,
  explorerCodeEditorReadyKey,
  isRetryableExplorerCodeConnectionError,
} from "./explorer-code-editor";
import { CantripApiError } from "@/lib/api";
import { codeWorkbenchStageError } from "@/lib/code-workbench-frame";
import { CodeControlOperationTimeoutError } from "@/lib/desktop-code";

function binding(
  overrides: Partial<Parameters<typeof explorerCodeEditorBindingKey>[0]> = {},
) {
  return explorerCodeEditorBindingKey({
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

describe("Explorer Code connection retry classification", () => {
  it("retries transport and server failures but not identity, auth, or limit responses", () => {
    expect(
      isRetryableExplorerCodeConnectionError(new TypeError("Load failed")),
    ).toBe(true);
    expect(
      isRetryableExplorerCodeConnectionError(
        new CantripApiError("Worker is offline.", 503),
      ),
    ).toBe(true);
    for (const status of [401, 404, 409, 429]) {
      expect(
        isRetryableExplorerCodeConnectionError(
          new CantripApiError("Do not retry.", status),
        ),
      ).toBe(false);
    }
    expect(
      isRetryableExplorerCodeConnectionError(
        new Error("This browser cannot host protected Code attachments."),
      ),
    ).toBe(false);
  });
});

describe("Explorer Code editor navigation", () => {
  it("recovers the existing route after bounded transient control retries", () => {
    const timeout = codeWorkbenchStageError(
      "file",
      new CodeControlOperationTimeoutError(),
    );

    expect(explorerCodeEditorOpenRecovery(timeout, 0, 0)).toBe("retry");
    expect(explorerCodeEditorOpenRecovery(timeout, 1, 0)).toBe("recover-route");
    expect(
      explorerCodeEditorOpenRecovery(new TypeError("Load failed"), 0, 0),
    ).toBe("retry");
    expect(
      explorerCodeEditorOpenRecovery(new TypeError("Load failed"), 1, 0),
    ).toBe("recover-route");
    expect(
      explorerCodeEditorOpenRecovery(new TypeError("Load failed"), 2, 1),
    ).toBe("error");
    const superseded = codeWorkbenchStageError(
      "file",
      new Error("Cantrip workbench bridge request was superseded."),
    );
    expect(explorerCodeEditorOpenRecovery(superseded, 0, 0)).toBe("retry");
    expect(explorerCodeEditorOpenRecovery(superseded, 1, 0)).toBe(
      "recover-route",
    );
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
