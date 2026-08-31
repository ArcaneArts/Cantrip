import { describe, expect, it } from "vitest";

import {
  explorerCodeEditorBindingKey,
  isRetryableExplorerCodeConnectionError,
} from "./explorer-code-editor";
import { CantripApiError } from "@/lib/api";

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
