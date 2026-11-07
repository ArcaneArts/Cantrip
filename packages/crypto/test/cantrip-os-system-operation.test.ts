import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encryptCantripOsSystemOperationResult,
  decryptCantripOsSystemOperationResult,
} from "../src/cantrip-os-system-operation.js";
import type { CantripOsSystemPrivateOperationResult } from "@cantrip/protocol";

function fixture() {
  const scope = {
    ownerId: "owner",
    serverId: "server",
    workerId: "worker",
    instanceId: randomUUID(),
    guestInstanceId: randomUUID(),
    attachmentGeneration: randomUUID(),
  };
  const generation = randomUUID(),
    operationId = randomUUID(),
    containerId = "a".repeat(64);
  const command = {
    type: "cantrip-os.system.capture" as const,
    action: "capture" as const,
    mode: "execute" as const,
    operationId,
    checkpointId: randomUUID(),
    resumeOriginal: true,
    scope,
    transport: { kind: "docker" as const, container: "fixture" },
    target: {
      generation,
      expected: {
        guestInstanceId: scope.guestInstanceId,
        ownerId: scope.ownerId,
        workerId: scope.workerId,
        identityPath: "/var/lib/cantrip-os-executor/instance.json",
      },
      containerId,
      containerName: "fixture",
      imageId: `sha256:${"b".repeat(64)}`,
      architecture: "amd64",
      identityEvidence: "guest-identity" as const,
    },
  };
  const value: CantripOsSystemPrivateOperationResult = {
    version: 1,
    command,
    capture: null,
    replacement: null,
    diagnostic: "/PRIVATE_ROOT_MARKER/雪",
  };
  return {
    context: {
      ...scope,
      targetGeneration: generation,
      operationId,
      containerId,
    },
    componentKey: randomBytes(32),
    keyRevision: 1,
    value,
  };
}
describe("private system operation outcomes", () => {
  it("binds the complete original authority and protects diagnostic paths", async () => {
    const f = fixture(),
      envelope = await encryptCantripOsSystemOperationResult(f);
    expect(JSON.stringify(envelope)).not.toContain("PRIVATE_ROOT_MARKER");
    expect(
      await decryptCantripOsSystemOperationResult({ ...f, envelope }),
    ).toEqual(f.value);
    for (const field of Object.keys(f.context) as Array<
      keyof typeof f.context
    >) {
      const value =
        field === "containerId"
          ? "c".repeat(64)
          : ["ownerId", "workerId", "serverId"].includes(field)
            ? "another-identity"
            : randomUUID();
      await expect(
        decryptCantripOsSystemOperationResult({
          ...f,
          context: { ...f.context, [field]: value },
          envelope,
        }),
      ).rejects.toThrow();
    }
    await expect(
      decryptCantripOsSystemOperationResult({
        ...f,
        componentKey: randomBytes(32),
        envelope,
      }),
    ).rejects.toThrow();
    await expect(
      decryptCantripOsSystemOperationResult({ ...f, keyRevision: 2, envelope }),
    ).rejects.toThrow();
  });
  it("refuses to encrypt a result for a different request or target", async () => {
    const f = fixture();
    await expect(
      encryptCantripOsSystemOperationResult({
        ...f,
        context: { ...f.context, operationId: randomUUID() },
      }),
    ).rejects.toThrow();
    await expect(
      encryptCantripOsSystemOperationResult({
        ...f,
        context: { ...f.context, containerId: "d".repeat(64) },
      }),
    ).rejects.toThrow();
  });
});
