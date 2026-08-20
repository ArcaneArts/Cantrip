import { describe, expect, it } from "vitest";

import {
  encryptedTerminalCreateSchema,
  encryptedTerminalServiceConfigurationSchema,
  terminalWireSummarySchema,
  workerCommandSchema,
} from "../src/index.js";

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

  it("keeps terminal paths and service commands out of server wire contracts", () => {
    const id = "00000000-0000-4000-8000-000000000101";
    const stateProtection = {
      classification: { recordKind: "terminal-state" as const },
      protectedState: encrypted,
    };
    const titleProtection = {
      classification: { recordKind: "terminal" as const },
      protectedLabel: encrypted,
    };
    expect(
      encryptedTerminalCreateSchema.safeParse({
        id,
        titleProtection,
        stateProtection,
        directoryPath: "private/path",
      }).success,
    ).toBe(false);
    expect(
      encryptedTerminalServiceConfigurationSchema.safeParse({
        enabled: true,
        stateProtection,
        command: "pnpm private",
      }).success,
    ).toBe(false);
    expect(
      terminalWireSummarySchema.safeParse({
        id,
        projectId: "project-1",
        position: 0,
        status: "idle",
        activeWorkerId: "worker-1",
        worktreeId: "worktree-1",
        linkedChatId: null,
        titleProtection,
        stateProtection,
        serviceEnabled: true,
        service: { enabled: true, command: "pnpm private" },
        createdAt: "2026-08-20T12:00:00.000Z",
        updatedAt: "2026-08-20T12:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      workerCommandSchema.safeParse({
        type: "terminal.open",
        terminalId: id,
        attachmentId: "attachment-1",
        serverId: "server-a",
        worktreePath: "/opaque/worktree",
        stateProtection,
        cwd: "/private/worktree/private/path",
        cols: 80,
        rows: 24,
        launch: { type: "shell" },
      }).success,
    ).toBe(false);
  });
});
