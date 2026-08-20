import { describe, expect, it } from "vitest";

import type {
  SurfacePrivateStateContext,
  SurfacePrivateStateProtectedContent,
} from "@cantrip/protocol/surface-private-state";

import {
  CantripDecryptionError,
  decryptPayload,
  decryptSurfacePrivateState,
  deriveFieldKey,
  encryptSurfacePrivateState,
  randomBytes,
  surfacePrivateStateAssociatedData,
} from "../src/index.js";

const ownerId = "owner-surface-state";
const keyRevision = 4;
const serverId = "https://cantrip.test";

const cases: Array<{
  context: SurfacePrivateStateContext;
  content: SurfacePrivateStateProtectedContent;
}> = [
  {
    context: {
      serverId,
      resource: "terminal-row",
      resourceId: "terminal-1",
      operationId: null,
      recordKind: "terminal-state",
    },
    content: {
      version: 1,
      classification: { recordKind: "terminal-state" },
      directory: { kind: "relative-path", path: "private/path" },
      serviceCommand: "pnpm private",
    },
  },
  {
    context: {
      serverId,
      resource: "explorer-row",
      resourceId: "explorer-1",
      operationId: null,
      recordKind: "explorer-state",
    },
    content: {
      version: 1,
      classification: { recordKind: "explorer-state" },
      selectedPath: "private/file.ts",
    },
  },
  {
    context: {
      serverId,
      resource: "browser-operation",
      resourceId: "browser-1",
      operationId: "navigate-1",
      recordKind: "browser-state",
    },
    content: {
      version: 1,
      classification: { recordKind: "browser-state" },
      revision: 1,
      url: "https://private.example/path",
    },
  },
  {
    context: {
      serverId,
      resource: "remote-desktop-row",
      resourceId: "desktop-1",
      operationId: null,
      recordKind: "remote-desktop-state",
    },
    content: {
      version: 1,
      classification: { recordKind: "remote-desktop-state" },
      revision: 1,
      target: {
        kind: "window",
        id: "window-secret",
        application: "Private App",
        title: "Private Window",
      },
    },
  },
  {
    context: {
      serverId,
      resource: "remote-desktop-inventory",
      resourceId: "worker-1",
      operationId: "inventory-1",
      recordKind: "remote-desktop-inventory",
    },
    content: {
      version: 1,
      classification: { recordKind: "remote-desktop-inventory" },
      monitors: [
        {
          kind: "monitor",
          id: "monitor-secret",
          name: "Private Display",
          x: 0,
          y: 0,
          width: 1920,
          height: 1080,
          primary: true,
        },
      ],
      windows: [],
      requested: null,
      active: null,
      launchingApplication: null,
      message: null,
    },
  },
];

describe("surface private-state trusted-endpoint codec", () => {
  it("round-trips every protected state kind", async () => {
    const componentKey = randomBytes(32);
    for (const entry of cases) {
      const opaque = await encryptSurfacePrivateState({
        ownerId,
        context: entry.context,
        keyRevision,
        componentKey,
        content: entry.content,
      });
      expect(JSON.stringify(opaque)).not.toContain("Private");
      await expect(
        decryptSurfacePrivateState({
          ownerId,
          context: entry.context,
          keyRevision,
          componentKey,
          opaque,
        }),
      ).resolves.toEqual(entry.content);
    }
  });

  it("binds owner, server, row, operation, resource/table, field, kind, and revision", async () => {
    const componentKey = randomBytes(32);
    const entry = cases[2]!;
    const opaque = await encryptSurfacePrivateState({
      ownerId,
      context: entry.context,
      keyRevision,
      componentKey,
      content: entry.content,
    });
    const base = {
      ownerId,
      context: entry.context,
      keyRevision,
      componentKey,
      opaque,
    };
    for (const changed of [
      { ownerId: "owner-other" },
      { context: { ...entry.context, serverId: "https://other.test" } },
      { context: { ...entry.context, resourceId: "browser-2" } },
      { context: { ...entry.context, operationId: "navigate-2" } },
      {
        context: {
          ...entry.context,
          resource: "browser-row",
          operationId: null,
        },
      },
      { keyRevision: keyRevision + 1 },
    ]) {
      await expect(
        decryptSurfacePrivateState({ ...base, ...changed } as typeof base),
      ).rejects.toBeInstanceOf(CantripDecryptionError);
    }

    const associatedData = surfacePrivateStateAssociatedData(base);
    const wrongField = { ...associatedData, field: "another_field" };
    const wrongFieldKey = deriveFieldKey({
      componentKey,
      ownerId,
      component: "surface-private-state",
      table: wrongField.table,
      field: wrongField.field,
      keyRevision,
    });
    await expect(
      decryptPayload({
        key: wrongFieldKey,
        envelope: opaque.protectedState.envelope,
        associatedData: wrongField,
      }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
  });

  it("rejects tampering and public/encrypted classification disagreement", async () => {
    const componentKey = randomBytes(32);
    const entry = cases[0]!;
    const opaque = await encryptSurfacePrivateState({
      ownerId,
      context: entry.context,
      keyRevision,
      componentKey,
      content: entry.content,
    });
    const ciphertext = opaque.protectedState.envelope.ciphertext;
    await expect(
      decryptSurfacePrivateState({
        ownerId,
        context: entry.context,
        keyRevision,
        componentKey,
        opaque: {
          ...opaque,
          protectedState: {
            ...opaque.protectedState,
            envelope: {
              ...opaque.protectedState.envelope,
              ciphertext: `${ciphertext.startsWith("A") ? "B" : "A"}${ciphertext.slice(1)}`,
            },
          },
        },
      }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
    await expect(
      decryptSurfacePrivateState({
        ownerId,
        context: entry.context,
        keyRevision,
        componentKey,
        opaque: {
          ...opaque,
          classification: { recordKind: "explorer-state" },
        },
      }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
  });
});
