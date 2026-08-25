import { describe, expect, it, vi } from "vitest";

import { interruptChatAcrossRuntimes } from "./runtime.js";

describe("Codex runtime chat interruption", () => {
  it("finds the active chat across differently configured runtimes", async () => {
    const inactiveRuntime = {
      interruptChat: vi.fn().mockResolvedValue({ interrupted: false }),
    };
    const activeRuntime = {
      interruptChat: vi.fn().mockResolvedValue({ interrupted: true }),
    };

    await expect(
      interruptChatAcrossRuntimes(
        [inactiveRuntime, activeRuntime],
        "task-chat",
        "task-thread",
      ),
    ).resolves.toEqual({ interrupted: true });
    expect(inactiveRuntime.interruptChat).toHaveBeenCalledWith(
      "task-chat",
      "task-thread",
    );
    expect(activeRuntime.interruptChat).toHaveBeenCalledWith(
      "task-chat",
      "task-thread",
    );
  });

  it("reports an inactive chat when no runtime owns the turn", async () => {
    await expect(
      interruptChatAcrossRuntimes(
        [
          {
            interruptChat: vi.fn().mockResolvedValue({ interrupted: false }),
          },
        ],
        "idle-chat",
        null,
      ),
    ).resolves.toEqual({ interrupted: false });
  });
});
