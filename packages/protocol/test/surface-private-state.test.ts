import { describe, expect, it } from "vitest";

import {
  browserPrivateStateOpaqueSchema,
  encryptedSurfacePrivateStateSchema,
  surfacePrivateStateContextSchema,
  surfacePrivateStateOpaqueSchema,
  surfacePrivateStateProtectedContentSchema,
  surfacePrivateStateRecordKindSchema,
  surfacePrivateStateResourceSchema,
} from "../src/surface-private-state.js";

const encrypted = {
  formatVersion: 1 as const,
  keyRevision: 2,
  envelope: {
    version: 1 as const,
    algorithm: "AES-256-GCM" as const,
    keyRevision: 2,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
};

describe("surface private-state contracts", () => {
  it("defines independently grantable opaque classifications and resources", () => {
    expect(surfacePrivateStateRecordKindSchema.options).toEqual([
      "terminal-state",
      "explorer-state",
      "browser-state",
      "remote-desktop-state",
      "remote-desktop-inventory",
    ]);
    expect(surfacePrivateStateResourceSchema.options).toContain(
      "browser-operation",
    );
    expect(
      surfacePrivateStateOpaqueSchema.parse({
        classification: { recordKind: "browser-state" },
        protectedState: encrypted,
      }),
    ).not.toHaveProperty("url");
    expect(
      browserPrivateStateOpaqueSchema.safeParse({
        classification: { recordKind: "terminal-state" },
        protectedState: encrypted,
      }).success,
    ).toBe(false);
  });

  it("keeps trusted endpoint content outside the opaque wire shape", () => {
    const content = surfacePrivateStateProtectedContentSchema.parse({
      version: 1,
      classification: { recordKind: "terminal-state" },
      directory: { kind: "project-root" },
      serviceCommand: "pnpm dev",
    });
    expect(content).toHaveProperty("serviceCommand", "pnpm dev");
    expect(
      surfacePrivateStateOpaqueSchema.safeParse({
        classification: content.classification,
        protectedState: encrypted,
        serviceCommand: "pnpm dev",
      }).success,
    ).toBe(false);
  });

  it("bounds context, content, versions, and envelope metadata", () => {
    expect(
      surfacePrivateStateContextSchema.safeParse({
        serverId: "server-a",
        resource: "browser-operation",
        resourceId: "browser-1",
        operationId: "navigation-1",
        recordKind: "browser-state",
      }).success,
    ).toBe(true);
    expect(
      surfacePrivateStateProtectedContentSchema.safeParse({
        version: 1,
        classification: { recordKind: "explorer-state" },
        selectedPath: "x".repeat(8_193),
      }).success,
    ).toBe(false);
    expect(
      encryptedSurfacePrivateStateSchema.safeParse({
        ...encrypted,
        formatVersion: 2,
      }).success,
    ).toBe(false);
    expect(
      encryptedSurfacePrivateStateSchema.safeParse({
        ...encrypted,
        keyRevision: 3,
      }).success,
    ).toBe(false);
  });
});
