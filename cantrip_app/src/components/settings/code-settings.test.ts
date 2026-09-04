import {
  unprobedCodexRuntimeReport,
  workerSummarySchema,
  type WorkerSummary,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  CODE_SETTINGS_FRAME_CLASS_NAME,
  CODE_SETTINGS_LOADING_COVER_CLASS_NAME,
  CODE_SETTINGS_SURFACE_CLASS_NAME,
  selectCodeSettingsWorker,
} from "./code-settings";

const now = "2026-08-23T12:00:00.000Z";

function worker(
  workerId: string,
  options: {
    code?: boolean;
    encryption?: boolean;
    encryptionState?: "pending-approval" | "ready";
    grants?: boolean;
    online?: boolean;
  } = {},
): WorkerSummary {
  return workerSummarySchema.parse({
    workerId,
    name: workerId,
    platform: "darwin",
    architecture: "arm64",
    codexVersion: null,
    codexRuntime: unprobedCodexRuntimeReport,
    code: {
      available: options.code ?? true,
      version: options.code === false ? null : "1.109.5-cantrip.1",
      upstreamRevision:
        options.code === false
          ? null
          : "4ffe2270acdf711bbefecc3e8c79f4b3631640e5",
      patchset: options.code === false ? 0 : 1,
      transport: "web-proxy",
      maxSessions: 4,
      reason: options.code === false ? "Not installed" : null,
    },
    encryption:
      options.encryption === false
        ? undefined
        : {
            supported: true,
            state: options.encryptionState ?? "ready",
            principalId: "11111111-1111-4111-8111-111111111111",
            grants:
              options.grants === false
                ? []
                : [
                    {
                      component: "customization-content",
                      keyRevision: 1,
                    },
                  ],
            lastSyncedAt: now,
            error: null,
          },
    startedAt: now,
    lastSeenAt: now,
    online: options.online ?? true,
  });
}

describe("Code settings worker selection", () => {
  it("prefers the configured eligible worker", () => {
    expect(
      selectCodeSettingsWorker(
        [worker("worker-a"), worker("worker-b")],
        "worker-b",
      )?.workerId,
    ).toBe("worker-b");
  });

  it("falls back safely when the default worker is unavailable", () => {
    expect(
      selectCodeSettingsWorker(
        [worker("worker-a"), worker("worker-b", { online: false })],
        "worker-b",
      )?.workerId,
    ).toBe("worker-a");
  });

  it("can select a fresh worker for on-demand encryption authorization", () => {
    expect(
      selectCodeSettingsWorker(
        [
          worker("pending", {
            encryptionState: "pending-approval",
            grants: false,
          }),
        ],
        null,
      )?.workerId,
    ).toBe("pending");
  });

  it("requires Code plus encryption capability", () => {
    expect(
      selectCodeSettingsWorker(
        [
          worker("offline", { online: false }),
          worker("no-code", { code: false }),
          worker("no-encryption", { encryption: false }),
        ],
        null,
      ),
    ).toBeNull();
  });
});

describe("Code settings background ownership", () => {
  it("leaves the surface and loading cover free of duplicate fills", () => {
    for (const className of [
      CODE_SETTINGS_SURFACE_CLASS_NAME,
      CODE_SETTINGS_FRAME_CLASS_NAME,
      CODE_SETTINGS_LOADING_COVER_CLASS_NAME,
    ]) {
      expect(className.split(/\s+/u)).not.toContain("bg-background");
    }
  });
});
