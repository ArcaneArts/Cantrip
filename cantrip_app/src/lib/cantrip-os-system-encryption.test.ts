import { afterEach, expect, it, vi } from "vitest";
import {
  clearSensitiveBytes,
  encryptCantripOsSystemOperationResult,
  generateAccountMasterKey,
} from "@cantrip/crypto";
import { cantripOsSystemOperationCommandSchema } from "@cantrip/protocol";
import { ClientEncryptionService } from "./client-encryption";
import type { ClientSessionContext } from "./client-session";
import { openCantripOsSystemResult } from "./cantrip-os-system-encryption";
import {
  cantripOsSystemTestFixture,
  systemTestId as id,
} from "./cantrip-os-system-test-fixture";
const services: ClientEncryptionService[] = [],
  keys: Uint8Array[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) service.lock();
  for (const key of keys.splice(0)) clearSensitiveBytes(key);
});
async function fixture(replace = false) {
  const f = cantripOsSystemTestFixture(),
    service = new ClientEncryptionService(),
    key = generateAccountMasterKey();
  services.push(service);
  keys.push(key);
  const identity = { ownerId: f.scope.ownerId, serverId: f.scope.serverId };
  service.setAccountMasterKey({
    accountMasterKey: key,
    identity,
    masterKeyRevision: 1,
  });
  const command = replace
    ? cantripOsSystemOperationCommandSchema.parse({
        type: "cantrip-os.system.replace",
        action: "replace",
        mode: "execute",
        operationId: f.context.operationId,
        scope: f.scope,
        transport: f.command.transport,
        target: f.physical,
        source: { kind: "base", imageId: f.physical.imageId },
        startTarget: true,
      })
    : f.command;
  const request = replace
    ? {
        operationId: f.context.operationId,
        attachmentGeneration: f.scope.attachmentGeneration,
        targetGeneration: f.context.targetGeneration,
        action: "replace" as const,
        source: { kind: "base" as const, imageId: f.physical.imageId },
        startTarget: true,
      }
    : f.request;
  const value = {
    version: 1 as const,
    command,
    capture: null,
    replacement: null,
    diagnostic: "Private /root/customized 日本 profile",
  };
  const componentKey = service.componentKey({
    component: "repository-content",
    identity,
    keyRevision: 1,
  });
  let protectedResult;
  try {
    protectedResult = await encryptCantripOsSystemOperationResult({
      context: f.context,
      componentKey,
      keyRevision: 1,
      value,
    });
  } finally {
    clearSensitiveBytes(componentKey);
  }
  const summary = { ...f.summary, request, protectedResult };
  const session = () =>
    ({
      serverId: identity.serverId,
      user: { id: identity.ownerId },
    }) as ClientSessionContext;
  return {
    ...f,
    summary,
    value,
    service,
    key,
    identity,
    options: { service, session },
  };
}
it("uses the original crypto context after the Server fence changes and supports old key revisions", async () => {
  const f = await fixture();
  expect(f.summary.attachmentGeneration).not.toBe(
    f.summary.context.attachmentGeneration,
  );
  expect(JSON.stringify(f.summary)).not.toContain(f.value.diagnostic);
  expect(await openCantripOsSystemResult(f.summary, f.options)).toEqual(
    f.value,
  );
  f.service.setAccountMasterKey({
    accountMasterKey: f.key,
    identity: f.identity,
    masterKeyRevision: 2,
  });
  expect(
    await openCantripOsSystemResult(
      { ...f.summary, recoveryGeneration: id(20) },
      f.options,
    ),
  ).toEqual(f.value);
  f.service.lock();
  await expect(openCantripOsSystemResult(f.summary, f.options)).rejects.toThrow(
    "Unlock encryption",
  );
});
it("rejects substituted identity, original attachment, operation or target contexts", async () => {
  const f = await fixture();
  for (const field of [
    "instanceId",
    "guestInstanceId",
    "attachmentGeneration",
    "targetGeneration",
    "operationId",
  ] as const)
    await expect(
      openCantripOsSystemResult(
        { ...f.summary, context: { ...f.context, [field]: id(30) } },
        f.options,
      ),
    ).rejects.toThrow("could not be authenticated");
  await expect(
    openCantripOsSystemResult(
      { ...f.summary, context: { ...f.context, ownerId: "other" } },
      f.options,
    ),
  ).rejects.toThrow("could not be authenticated");
  await expect(
    openCantripOsSystemResult(
      { ...f.summary, request: { ...f.request, resumeOriginal: false } },
      f.options,
    ),
  ).rejects.toThrow("could not be authenticated");
});
it("authenticates the public replacement source and start policy against its private command", async () => {
  const f = await fixture(true);
  expect(await openCantripOsSystemResult(f.summary, f.options)).toEqual(
    f.value,
  );
  if (f.summary.request.action !== "replace")
    throw new Error("Replacement fixture");
  for (const request of [
    { ...f.summary.request, startTarget: false },
    {
      ...f.summary.request,
      source: { kind: "base" as const, imageId: `sha256:${"c".repeat(64)}` },
    },
    {
      ...f.summary.request,
      source: { kind: "checkpoint" as const, operationId: id(31) },
    },
  ])
    await expect(
      openCantripOsSystemResult({ ...f.summary, request }, f.options),
    ).rejects.toThrow("could not be authenticated");
});
it("withholds private results if encryption locks while the key is being acquired", async () => {
  const f = await fixture(),
    componentKey = f.service.componentKey.bind(f.service);
  vi.spyOn(f.service, "componentKey").mockImplementationOnce((input) => {
    const key = componentKey(input);
    f.service.lock();
    return key;
  });
  await expect(openCantripOsSystemResult(f.summary, f.options)).rejects.toThrow(
    "could not be authenticated",
  );
});
