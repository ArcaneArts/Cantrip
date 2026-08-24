import { describe, expect, it, vi } from "vitest";

import {
  installRunConfigurationFocusRecovery,
  runConfigurationRecoveryQueryKeys,
} from "./run-configuration-focus-recovery";

class VisibilityTarget extends EventTarget {
  visibilityState: DocumentVisibilityState = "hidden";
}

function host() {
  return {
    document: new VisibilityTarget(),
    window: new EventTarget(),
  };
}

async function flushRecovery(): Promise<void> {
  await Promise.resolve();
}

describe("Run configuration focus recovery", () => {
  it("coalesces browser/Tauri focus and mobile visibility recovery", async () => {
    const targets = host();
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    const dispose = installRunConfigurationFocusRecovery(
      { invalidateQueries },
      "project-one",
      targets,
    );

    targets.document.visibilityState = "visible";
    targets.window.dispatchEvent(new Event("focus"));
    targets.document.dispatchEvent(new Event("visibilitychange"));
    await flushRecovery();

    expect(invalidateQueries.mock.calls.map(([input]) => input)).toEqual(
      runConfigurationRecoveryQueryKeys("project-one").map((queryKey) => ({
        exact: true,
        queryKey,
      })),
    );
    dispose();
  });

  it("ignores hidden visibility changes and queued work after disposal", async () => {
    const targets = host();
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    const dispose = installRunConfigurationFocusRecovery(
      { invalidateQueries },
      "project-one",
      targets,
    );

    targets.document.dispatchEvent(new Event("visibilitychange"));
    targets.window.dispatchEvent(new Event("focus"));
    dispose();
    await flushRecovery();
    targets.document.visibilityState = "visible";
    targets.document.dispatchEvent(new Event("visibilitychange"));
    await flushRecovery();

    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
