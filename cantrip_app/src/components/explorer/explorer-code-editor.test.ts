import { describe, expect, it } from "vitest";

import {
  explorerCodeEditorBindingKey,
  explorerCodeEditorReadyKey,
} from "./explorer-code-editor";

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
