import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encryptCantripOsPackageResult,
  decryptCantripOsPackageResult,
} from "../src/cantrip-os-packages.js";
import type { CantripOsPackagePrivateResult } from "@cantrip/protocol";
import { encryptCantripOsBackupFrame } from "../src/cantrip-os-backup.js";

function fixture() {
  const context = {
    ownerId: "owner",
    serverId: "https://packages.example.invalid",
    workerId: "worker",
    instanceId: randomUUID(),
    attachmentGeneration: randomUUID(),
    targetGeneration: randomUUID(),
    operationId: randomUUID(),
  };
  const input = {
    context,
    keyRevision: 1,
    componentKey: new Uint8Array(randomBytes(32)),
  };
  const value: CantripOsPackagePrivateResult = {
    version: 1,
    request: {
      version: 2,
      operationId: context.operationId,
      scopeKey: "a".repeat(64),
      action: "repair",
      configuration: "preserve",
      expected: {
        guestInstanceId: randomUUID(),
        ownerId: context.ownerId,
        workerId: context.workerId,
        identityPath: "/private/guest/instance.json",
        bootId: randomUUID(),
        initStart: "1234",
      },
      packages: [
        {
          name: "cantrip-os-recovery",
          version: "0.5.0",
          architecture: "all",
          sha256: "b".repeat(64),
          bytes: 42,
        },
      ],
    },
    record: null,
    diagnostic: "/private/guest/root-customization: actual repair error",
  };
  return { input, value };
}
describe("private package outcomes", () => {
  it("rejects a backup-channel envelope and altered ciphertext with the same account key", async () => {
    const { input, value } = fixture();
    const frame = await encryptCantripOsBackupFrame({
      context: {
        ownerId: input.context.ownerId,
        serverId: input.context.serverId,
        backupId: input.context.operationId,
      },
      componentKey: input.componentKey,
      keyRevision: 1,
      kind: "metadata",
      sequence: 2,
      plaintext: new TextEncoder().encode(JSON.stringify(value)),
    });
    await expect(
      decryptCantripOsPackageResult({ ...input, envelope: frame.envelope }),
    ).rejects.toThrow();
    const envelope = await encryptCantripOsPackageResult({ ...input, value });
    const first = envelope.ciphertext[0] === "A" ? "B" : "A";
    await expect(
      decryptCantripOsPackageResult({
        ...input,
        envelope: {
          ...envelope,
          ciphertext: first + envelope.ciphertext.slice(1),
        },
      }),
    ).rejects.toThrow();
  });
  it("roundtrips diagnostics while binding every routing identity", async () => {
    const { input, value } = fixture();
    const envelope = await encryptCantripOsPackageResult({ ...input, value });
    expect(JSON.stringify(envelope)).not.toContain("root-customization");
    expect(await decryptCantripOsPackageResult({ ...input, envelope })).toEqual(
      value,
    );
    for (const field of [
      "ownerId",
      "serverId",
      "workerId",
      "instanceId",
      "attachmentGeneration",
      "targetGeneration",
      "operationId",
    ] as const) {
      const changed =
        (field.endsWith("Id") &&
          !["ownerId", "workerId", "serverId"].includes(field)) ||
        field.endsWith("Generation")
          ? randomUUID()
          : "another-identity";
      await expect(
        decryptCantripOsPackageResult({
          ...input,
          context: { ...input.context, [field]: changed },
          envelope,
        }),
      ).rejects.toThrow();
    }
    await expect(
      decryptCantripOsPackageResult({
        ...input,
        componentKey: new Uint8Array(randomBytes(32)),
        envelope,
      }),
    ).rejects.toThrow();
    await expect(
      decryptCantripOsPackageResult({ ...input, keyRevision: 2, envelope }),
    ).rejects.toThrow();
  });
  it("accepts the maximum logical Server identity without exceeding AAD row limits", async () => {
    const { input, value } = fixture();
    input.context.serverId = "s".repeat(2000);
    input.context.workerId = "w".repeat(200);
    value.request.expected.workerId = input.context.workerId;
    const envelope = await encryptCantripOsPackageResult({ ...input, value });
    expect(await decryptCantripOsPackageResult({ ...input, envelope })).toEqual(
      value,
    );
  });
  it("rejects mismatched plaintext ownership before producing a result", async () => {
    const { input, value } = fixture();
    value.request.expected.ownerId = "other-owner";
    await expect(
      encryptCantripOsPackageResult({ ...input, value }),
    ).rejects.toThrow("ownership changed");
  });
});
