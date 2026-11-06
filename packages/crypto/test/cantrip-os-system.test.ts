import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encryptCantripOsSystemFrame,
  decryptCantripOsSystemFrame,
} from "../src/cantrip-os-system.js";
import { encryptCantripOsBackupFrame } from "../src/cantrip-os-backup.js";

function fixture() {
  return {
    context: {
      ownerId: "owner",
      serverId: "https://system.example.invalid",
      workerId: "worker",
      instanceId: randomUUID(),
      guestInstanceId: randomUUID(),
      attachmentGeneration: randomUUID(),
      targetGeneration: randomUUID(),
      operationId: randomUUID(),
      checkpointId: randomUUID(),
      containerId: "a".repeat(64),
    },
    streamId: randomUUID(),
    keyRevision: 1,
    componentKey: randomBytes(32),
  };
}
describe("private system frame cryptography", () => {
  it("supports the full protocol identity lengths within the envelope AAD bound", async () => {
    const input = fixture();
    input.context.ownerId = "o".repeat(200);
    input.context.workerId = "w".repeat(200);
    input.context.serverId = "s".repeat(2_000);
    const frame = await encryptCantripOsSystemFrame({
      ...input,
      kind: "result",
      sequence: Number.MAX_SAFE_INTEGER,
      plaintext: Buffer.from("wide-identities"),
    });
    expect(
      new TextDecoder().decode(
        await decryptCantripOsSystemFrame({ ...input, frame }),
      ),
    ).toBe("wide-identities");
  });
  it("binds every placement identity, stream, frame kind, order and key", async () => {
    const input = fixture(),
      plaintext = Buffer.from("PRIVATE_ROOT_CONFIG_雪");
    const frame = await encryptCantripOsSystemFrame({
      ...input,
      plaintext,
      kind: "chunk",
      sequence: 2,
    });
    expect(await decryptCantripOsSystemFrame({ ...input, frame })).toEqual(
      new Uint8Array(plaintext),
    );
    for (const field of Object.keys(input.context) as Array<
      keyof typeof input.context
    >) {
      const value =
        field === "containerId"
          ? "b".repeat(64)
          : ["ownerId", "serverId", "workerId"].includes(field)
            ? "changed"
            : randomUUID();
      await expect(
        decryptCantripOsSystemFrame({
          ...input,
          context: { ...input.context, [field]: value },
          frame,
        }),
      ).rejects.toThrow();
    }
    for (const changed of [
      { streamId: randomUUID() },
      { componentKey: randomBytes(32) },
      { keyRevision: 2 },
      { frame: { ...frame, sequence: 3 } },
      { frame: { ...frame, kind: "end" as const } },
    ])
      await expect(
        decryptCantripOsSystemFrame({ ...input, frame, ...changed }),
      ).rejects.toThrow();
  });
  it("isolates result and archive fields from workspace backup ciphertext and enforces bounds", async () => {
    const input = fixture();
    const foreign = await encryptCantripOsBackupFrame({
      ...input,
      context: {
        ownerId: input.context.ownerId,
        serverId: input.context.serverId,
        backupId: input.context.checkpointId,
      },
      kind: "chunk",
      sequence: 0,
      plaintext: Buffer.from("foreign"),
    });
    await expect(
      decryptCantripOsSystemFrame({ ...input, frame: foreign }),
    ).rejects.toThrow();
    await expect(
      encryptCantripOsSystemFrame({
        ...input,
        kind: "chunk",
        sequence: 0,
        plaintext: Buffer.alloc(1_048_577),
      }),
    ).rejects.toThrow();
    for (const kind of ["manifest", "end", "result"] as const) {
      const frame = await encryptCantripOsSystemFrame({
        ...input,
        kind,
        sequence: 0,
        plaintext: Buffer.from(kind),
      });
      expect(
        new TextDecoder().decode(
          await decryptCantripOsSystemFrame({ ...input, frame }),
        ),
      ).toBe(kind);
    }
  });
});
