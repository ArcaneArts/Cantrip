import { describe, expect, it } from "vitest";

import type { PrivateDisplayLabelRecordKind } from "@cantrip/protocol/private-labels";

import {
  CantripDecryptionError,
  decryptPayload,
  decryptPrivateDisplayLabel,
  deriveFieldKey,
  encryptPrivateDisplayLabel,
  privateDisplayLabelAssociatedData,
  privateDisplayLabelTables,
  randomBytes,
} from "../src/index.js";

const ownerId = "owner-private-labels";
const keyRevision = 3;
const recordKinds = Object.keys(
  privateDisplayLabelTables,
) as PrivateDisplayLabelRecordKind[];

function tampered(ciphertext: string): string {
  return `${ciphertext.startsWith("A") ? "B" : "A"}${ciphertext.slice(1)}`;
}

describe("private display-label trusted-endpoint codec", () => {
  it("round-trips every record kind with its exact table contract", async () => {
    const componentKey = randomBytes(32);
    for (const [index, recordKind] of recordKinds.entries()) {
      const rowId = `row-${index}`;
      const label = `Sentinel private ${recordKind} label`;
      const opaque = await encryptPrivateDisplayLabel({
        ownerId,
        recordKind,
        rowId,
        keyRevision,
        componentKey,
        label,
      });
      await expect(
        decryptPrivateDisplayLabel({
          ownerId,
          recordKind,
          rowId,
          keyRevision,
          componentKey,
          opaque,
        }),
      ).resolves.toBe(label);
      expect(
        privateDisplayLabelAssociatedData({
          ownerId,
          recordKind,
          rowId,
          keyRevision,
        }),
      ).toMatchObject({
        component: "private-surface-metadata",
        table: privateDisplayLabelTables[recordKind],
        field: "protected_label",
      });
    }
  });

  it("binds owner, table/kind, row, field, and key revision", async () => {
    const componentKey = randomBytes(32);
    const opaque = await encryptPrivateDisplayLabel({
      ownerId,
      recordKind: "project",
      rowId: "project-1",
      keyRevision,
      componentKey,
      label: "Sentinel private project",
    });
    const base = {
      ownerId,
      recordKind: "project" as const,
      rowId: "project-1",
      keyRevision,
      componentKey,
      opaque,
    };
    await expect(
      decryptPrivateDisplayLabel({ ...base, ownerId: "owner-other" }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
    await expect(
      decryptPrivateDisplayLabel({ ...base, rowId: "project-2" }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
    await expect(
      decryptPrivateDisplayLabel({ ...base, recordKind: "chat" }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
    await expect(
      decryptPrivateDisplayLabel({
        ...base,
        keyRevision: keyRevision + 1,
      }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);

    const wrongAssociatedData = {
      ...privateDisplayLabelAssociatedData(base),
      field: "title",
    };
    const wrongFieldKey = deriveFieldKey({
      componentKey,
      ownerId,
      component: "private-surface-metadata",
      table: wrongAssociatedData.table,
      field: wrongAssociatedData.field,
      keyRevision,
    });
    await expect(
      decryptPayload({
        key: wrongFieldKey,
        envelope: opaque.protectedLabel.envelope,
        associatedData: wrongAssociatedData,
      }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
  });

  it("rejects tampering and public/encrypted classification disagreement", async () => {
    const componentKey = randomBytes(32);
    const opaque = await encryptPrivateDisplayLabel({
      ownerId,
      recordKind: "chat",
      rowId: "chat-1",
      keyRevision,
      componentKey,
      label: "Sentinel private chat",
    });
    await expect(
      decryptPrivateDisplayLabel({
        ownerId,
        recordKind: "chat",
        rowId: "chat-1",
        keyRevision,
        componentKey,
        opaque: {
          ...opaque,
          protectedLabel: {
            ...opaque.protectedLabel,
            envelope: {
              ...opaque.protectedLabel.envelope,
              ciphertext: tampered(opaque.protectedLabel.envelope.ciphertext),
            },
          },
        },
      }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
    await expect(
      decryptPrivateDisplayLabel({
        ownerId,
        recordKind: "chat",
        rowId: "chat-1",
        keyRevision,
        componentKey,
        opaque: {
          ...opaque,
          classification: { recordKind: "project" },
        },
      }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
  });
});
