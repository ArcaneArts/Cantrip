import type { WorkerEncryptionStatus } from "@cantrip/protocol/encryption";
import { describe, expect, it } from "vitest";

import { workerEncryptionRefreshChangesSurfaceMaterial } from "../src/worker-encryption-refresh.js";

const status = (overrides: Partial<WorkerEncryptionStatus> = {}) => ({
  supported: true,
  state: "ready" as const,
  principalId: "11111111-1111-4111-8111-111111111111",
  grants: [{ component: "surface-private-state" as const, keyRevision: 3 }],
  lastSyncedAt: "2026-08-26T00:00:00.000Z",
  error: null,
  ...overrides,
});

describe("worker encryption refresh reconciliation", () => {
  it("ignores timestamps and non-surface refreshes", () => {
    expect(
      workerEncryptionRefreshChangesSurfaceMaterial({
        before: status(),
        after: status({ lastSyncedAt: "2026-08-26T00:10:00.000Z" }),
        component: "surface-private-state",
      }),
    ).toBe(false);
    expect(
      workerEncryptionRefreshChangesSurfaceMaterial({
        before: status(),
        after: status({
          grants: [{ component: "surface-private-state", keyRevision: 4 }],
        }),
        component: "task-content",
      }),
    ).toBe(false);
  });

  it("reconciles one material surface encryption change", () => {
    expect(
      workerEncryptionRefreshChangesSurfaceMaterial({
        before: status(),
        after: status({
          grants: [{ component: "surface-private-state", keyRevision: 4 }],
        }),
        component: "surface-private-state",
      }),
    ).toBe(true);
  });
});
