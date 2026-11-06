import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  encryptCantripOsBackupMessage,
  decryptCantripOsBackupMessage,
  encryptCantripOsBackupFrame,
  randomBytes,
} from "../src/index.js";

it("separates backup operation requests, responses and file metadata", async () => {
  const identity = {
    ownerId: "owner",
    serverId: "server",
    operationId: randomUUID(),
    keyRevision: 1,
    componentKey: randomBytes(32),
  };
  const plaintext = new TextEncoder().encode("private workspace intent");
  const frame = await encryptCantripOsBackupMessage({
    ...identity,
    direction: "request",
    plaintext,
  });
  expect(
    await decryptCantripOsBackupMessage({
      ...identity,
      direction: "request",
      frame,
    }),
  ).toEqual(plaintext);
  await expect(
    decryptCantripOsBackupMessage({
      ...identity,
      direction: "response",
      frame,
    }),
  ).rejects.toThrow();
  await expect(
    decryptCantripOsBackupMessage({
      ...identity,
      operationId: randomUUID(),
      direction: "request",
      frame,
    }),
  ).rejects.toThrow();
  const file = await encryptCantripOsBackupFrame({
    ...identity,
    context: {
      ownerId: identity.ownerId,
      serverId: identity.serverId,
      backupId: identity.operationId,
    },
    kind: "metadata",
    sequence: 0,
    plaintext,
  });
  await expect(
    decryptCantripOsBackupMessage({
      ...identity,
      direction: "request",
      frame: file,
    }),
  ).rejects.toThrow();
});
