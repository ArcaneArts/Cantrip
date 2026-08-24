import { describe, expect, it } from "vitest";

import {
  CODE_SETTINGS_OPERATION,
  codeSettingsContentContext,
  codeSettingsPayloadSchema,
  codeSettingsPublicStatusSchema,
  codeSettingsUploadSchema,
  codeSettingsWorkerStatusSchema,
  protectedCodeSettingsRecordSchema,
} from "../src/code-settings.js";

function protectedRecord(revision = 1) {
  return {
    operationId: "11111111-1111-4111-8111-111111111111",
    revision,
    protectedContent: {
      formatVersion: 1 as const,
      domain: "customization-content" as const,
      keyRevision: 1,
      envelope: {
        version: 1 as const,
        algorithm: "AES-256-GCM" as const,
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    },
  };
}

describe("global Code settings protocol", () => {
  it("accepts bounded semantic settings while retaining user-facing Cantrip preferences", () => {
    expect(
      codeSettingsPayloadSchema.parse({
        formatVersion: 1,
        settings: {
          "editor.fontSize": 15,
          "[typescript]": { "editor.formatOnSave": true },
          "cantrip.saveBeforeAgentTurn": "ask",
        },
      }),
    ).toMatchObject({ settings: { "editor.fontSize": 15 } });
  });

  it.each([
    "cantrip.bridgeToken",
    "cantrip.bridgeUrl",
    "cantrip.sessionId",
    "cantrip.workerId",
    "cantrip.projectId",
    "cantrip.worktreeId",
  ])("rejects the session-owned %s setting", (key) => {
    expect(() =>
      codeSettingsPayloadSchema.parse({
        formatVersion: 1,
        settings: { [key]: "private-runtime-value" },
      }),
    ).toThrow(/managed by the Cantrip Code session/u);
  });

  it("rejects oversized, deeply nested, and non-finite JSON settings", () => {
    expect(() =>
      codeSettingsPayloadSchema.parse({
        formatVersion: 1,
        settings: { huge: "x".repeat(1_000_001) },
      }),
    ).toThrow();
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 34; depth += 1) nested = { nested };
    expect(() =>
      codeSettingsPayloadSchema.parse({ formatVersion: 1, settings: nested }),
    ).toThrow(/nested/u);
    expect(() =>
      codeSettingsPayloadSchema.parse({
        formatVersion: 1,
        settings: { invalid: Number.POSITIVE_INFINITY },
      }),
    ).toThrow(/finite/u);
  });

  it("accepts only customization-content ciphertext", () => {
    expect(protectedCodeSettingsRecordSchema.parse(protectedRecord())).toEqual(
      protectedRecord(),
    );
    expect(() =>
      protectedCodeSettingsRecordSchema.parse({
        ...protectedRecord(),
        protectedContent: {
          ...protectedRecord().protectedContent,
          domain: "tunnel-content",
        },
      }),
    ).toThrow(/customization-content/u);
  });

  it("enforces create and compare-and-swap revision progression", () => {
    expect(
      codeSettingsUploadSchema.parse({
        expectedRevision: null,
        record: protectedRecord(1),
      }).record.revision,
    ).toBe(1);
    expect(
      codeSettingsUploadSchema.parse({
        expectedRevision: 1,
        record: protectedRecord(2),
      }).record.revision,
    ).toBe(2);
    expect(() =>
      codeSettingsUploadSchema.parse({
        expectedRevision: 1,
        record: protectedRecord(3),
      }),
    ).toThrow(/must be 2/u);
  });

  it("binds durable ciphertext to a worker-neutral authenticated context", () => {
    expect(
      codeSettingsContentContext({
        operationId: protectedRecord().operationId,
        profileId: "default",
        revision: 1,
        serverId: "logical-server-id",
      }),
    ).toEqual({
      domain: "customization-content",
      serverId: "logical-server-id",
      workerId: null,
      scopeId: '["global-code-settings","default"]',
      operationId: protectedRecord().operationId,
      operation: CODE_SETTINGS_OPERATION,
      direction: "stored",
      sequence: 1,
    });
  });

  it("does not permit initialized public status without revision metadata", () => {
    expect(() =>
      codeSettingsPublicStatusSchema.parse({
        profileId: "default",
        initialized: true,
        revision: null,
        updatedAt: null,
        updatedByWorkerId: null,
      }),
    ).toThrow(/revision metadata/u);
  });

  it("exposes synchronization metadata without settings content", () => {
    const status = codeSettingsWorkerStatusSchema.parse({
      profileId: "default",
      state: "conflict",
      revision: 4,
      conflictCount: 2,
      initializedFromWorker: false,
      backupCreated: true,
      lastSynchronizedAt: null,
      error: null,
    });
    expect(status).not.toHaveProperty("settings");
    expect(() =>
      codeSettingsWorkerStatusSchema.parse({
        ...status,
        state: "ready",
      }),
    ).toThrow(/conflict state/u);
  });
});
