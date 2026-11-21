import { describe, expect, it, vi } from "vitest";
import { createNativeSharedViewFixture } from "./native-shared-view-fixture.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();

describe.skipIf(!binary)("native CLI discovery receipt recovery", () => {
  it("keeps the actual idle TUI attached after a discovery receipt failure", async () => {
    let failedReceipts = 0;
    const f = await createNativeSharedViewFixture(
      binary!,
      "http://127.0.0.1:9/v1",
      {
        plugins: true,
        afterNativeReceipt(method) {
          if (method === "plugin/list") {
            failedReceipts++;
            throw new Error(
              "Fixture lost the discovery receipt acknowledgement.",
            );
          }
        },
      },
    );
    try {
      await vi.waitFor(() => expect(failedReceipts).toBeGreaterThan(0), {
        timeout: 10000,
      });
      // Cover several of the reported one-to-two-second reconnect cycles,
      // while the GUI independently reads this same native thread.
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await f.runtime.readNativeHistory(f.threadId);
      }
      expect(f.diagnostics().terminal).not.toContain("Reconnected.");
      expect(f.terminalText()).not.toContain("Reconnecting to app-server");
      expect(
        f.frames.filter((frame) => frame.result?.cantripManagedGateway),
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  }, 30000);
});
