import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encryptCantripOsBackupFrame,
  decryptCantripOsBackupFrame,
  randomBytes,
} from "../src/index.js";

describe("private CantripOS backup frame authentication", () => {
  it("binds the account, Server, backup, revision, frame kind and sequence", async () => {
    const context = {
      ownerId: "owner",
      serverId: "server",
      backupId: randomUUID(),
    };
    const input = { context, keyRevision: 3, componentKey: randomBytes(32) };
    const plaintext = new TextEncoder().encode("private profile bytes\0雪");
    const frame = await encryptCantripOsBackupFrame({
      ...input,
      kind: "chunk",
      sequence: 7,
      plaintext,
    });
    expect(await decryptCantripOsBackupFrame({ ...input, frame })).toEqual(
      plaintext,
    );
    for (const changed of [
      { ...input, context: { ...context, ownerId: "other" } },
      { ...input, context: { ...context, serverId: "other" } },
      { ...input, context: { ...context, backupId: randomUUID() } },
      { ...input, keyRevision: 4 },
      { ...input, componentKey: randomBytes(32) },
    ])
      await expect(
        decryptCantripOsBackupFrame({ ...changed, frame }),
      ).rejects.toThrow("could not be authenticated");
    await expect(
      decryptCantripOsBackupFrame({
        ...input,
        frame: { ...frame, kind: "metadata" },
      }),
    ).rejects.toThrow();
    await expect(
      decryptCantripOsBackupFrame({
        ...input,
        frame: { ...frame, sequence: 8 },
      }),
    ).rejects.toThrow();
  });
});
