import {
  workerSummarySchema,
  type WorkerEncryptionStatus,
  type WorkerSummary,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { workerPresenceFingerprint } from "../src/workers/presence.js";

const readyEncryption = (
  overrides: Partial<WorkerEncryptionStatus> = {},
): WorkerEncryptionStatus => ({
  supported: true,
  state: "ready",
  principalId: "11111111-1111-4111-8111-111111111111",
  grants: [
    { component: "surface-private-state", keyRevision: 3 },
    { component: "private-surface-metadata", keyRevision: 3 },
  ],
  lastSyncedAt: "2026-08-26T00:00:00.000Z",
  error: null,
  ...overrides,
});

const worker = (overrides: Partial<WorkerSummary> = {}): WorkerSummary =>
  workerSummarySchema.parse({
    workerId: "worker-one",
    name: "Worker One",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: null,
    encryption: readyEncryption(),
    startedAt: "2026-08-26T00:00:00.000Z",
    online: true,
    lastSeenAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  });

describe("worker presence fingerprint", () => {
  it("ignores heartbeat and encryption synchronization timestamps", () => {
    const current = workerPresenceFingerprint(worker());
    expect(
      workerPresenceFingerprint(
        worker({ lastSeenAt: "2026-08-26T00:00:05.000Z" }),
      ),
    ).toBe(current);
    expect(
      workerPresenceFingerprint(
        worker({
          encryption: readyEncryption({
            lastSyncedAt: "2026-08-26T00:00:05.000Z",
          }),
        }),
      ),
    ).toBe(current);
  });

  it("coalesces ten timestamp-only heartbeats into one semantic observation", () => {
    const observations = new Set(
      Array.from({ length: 10 }, (_, index) =>
        workerPresenceFingerprint(
          worker({
            lastSeenAt: `2026-08-26T00:00:${String(index * 5).padStart(2, "0")}.000Z`,
            encryption: readyEncryption({
              lastSyncedAt: `2026-08-26T00:00:${String(index * 5).padStart(2, "0")}.000Z`,
            }),
          }),
        ),
      ),
    );
    expect(observations.size).toBe(1);
  });

  it("tracks availability, capabilities, and material encryption changes", () => {
    const current = workerPresenceFingerprint(worker());
    expect(workerPresenceFingerprint(worker({ online: false }))).not.toBe(
      current,
    );
    expect(
      workerPresenceFingerprint(worker({ chatRelocation: true })),
    ).not.toBe(current);
    expect(
      workerPresenceFingerprint(
        worker({
          webRuntimes: {
            ...worker().webRuntimes,
            staticReading: true,
          },
        }),
      ),
    ).not.toBe(current);
    expect(
      workerPresenceFingerprint(
        worker({
          encryption: readyEncryption({
            grants: [
              { component: "surface-private-state", keyRevision: 4 },
              { component: "private-surface-metadata", keyRevision: 4 },
            ],
          }),
        }),
      ),
    ).not.toBe(current);
    expect(
      workerPresenceFingerprint(
        worker({
          encryption: readyEncryption({
            principalId: "22222222-2222-4222-8222-222222222222",
          }),
        }),
      ),
    ).not.toBe(current);
    expect(
      workerPresenceFingerprint(
        worker({
          encryption: readyEncryption({
            state: "error",
            error: "refresh failed",
          }),
        }),
      ),
    ).not.toBe(current);
  });

  it("normalizes equivalent encryption grant order", () => {
    const current = workerPresenceFingerprint(worker());
    expect(
      workerPresenceFingerprint(
        worker({
          encryption: readyEncryption({
            grants: [...readyEncryption().grants].reverse(),
          }),
        }),
      ),
    ).toBe(current);
  });
});
