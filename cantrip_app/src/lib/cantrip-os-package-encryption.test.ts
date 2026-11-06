import { afterEach, expect, it, vi } from "vitest";
import {
  clearSensitiveBytes,
  encryptCantripOsPackageResult,
  generateAccountMasterKey,
} from "@cantrip/crypto";
import {
  cantripOsGuestPackageRequestSchema,
  cantripOsPackageSummarySchema,
} from "@cantrip/protocol";
import { ClientEncryptionService } from "./client-encryption";
import type { ClientSessionContext } from "./client-session";
import { openCantripOsPackageResult } from "./cantrip-os-package-encryption";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { ownerId: "owner", serverId: "server" };
const services: ClientEncryptionService[] = [],
  keys: Uint8Array[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) service.lock();
  for (const key of keys.splice(0)) clearSensitiveBytes(key);
});
async function fixture() {
  const service = new ClientEncryptionService(),
    key = generateAccountMasterKey();
  services.push(service);
  keys.push(key);
  service.setAccountMasterKey({
    accountMasterKey: key,
    identity,
    masterKeyRevision: 1,
  });
  const context = {
    ...identity,
    workerId: "worker",
    instanceId: id(1),
    attachmentGeneration: id(2),
    targetGeneration: id(3),
    operationId: id(4),
  };
  const artifact = {
    name: "cantrip-os-recovery",
    version: "0.5.0",
    architecture: "all",
    sha256: "a".repeat(64),
    bytes: 21484,
  };
  const request = cantripOsGuestPackageRequestSchema.parse({
    version: 2,
    operationId: context.operationId,
    scopeKey: "b".repeat(64),
    action: "repair",
    configuration: "preserve",
    packages: [artifact],
    expected: {
      guestInstanceId: id(5),
      ownerId: identity.ownerId,
      workerId: context.workerId,
      identityPath: "/private/guest/instance.json",
      bootId: id(6),
      initStart: "1",
    },
  });
  const value = {
    version: 1 as const,
    request,
    record: null,
    diagnostic: "Private /root/customized 日本 profile",
  };
  const componentKey = service.componentKey({
    component: "repository-content",
    identity,
    keyRevision: 1,
  });
  let protectedResult;
  try {
    protectedResult = await encryptCantripOsPackageResult({
      context,
      componentKey,
      keyRevision: 1,
      value,
    });
  } finally {
    clearSensitiveBytes(componentKey);
  }
  const summary = cantripOsPackageSummarySchema.parse({
    operationId: context.operationId,
    instanceId: context.instanceId,
    workerId: context.workerId,
    attachmentGeneration: context.attachmentGeneration,
    targetGeneration: context.targetGeneration,
    action: request.action,
    configuration: request.configuration,
    packages: request.packages,
    state: "unknown",
    phase: "admitted",
    createdAt: "2026-11-06T00:00:00.000Z",
    updatedAt: "2026-11-06T00:00:00.000Z",
    error: null,
    protectedResult,
  });
  const session = () =>
    ({
      serverId: identity.serverId,
      user: { id: identity.ownerId },
    }) as ClientSessionContext;
  return { service, key, summary, value, options: { service, session } };
}
it("opens authenticated private outcomes across key revisions without exposing diagnostics in public summaries", async () => {
  const f = await fixture();
  expect(JSON.stringify(f.summary)).not.toContain(f.value.diagnostic);
  expect(await openCantripOsPackageResult(f.summary, f.options)).toEqual(
    f.value,
  );
  f.service.setAccountMasterKey({
    accountMasterKey: f.key,
    identity,
    masterKeyRevision: 2,
  });
  expect(await openCantripOsPackageResult(f.summary, f.options)).toEqual(
    f.value,
  );
  f.service.lock();
  await expect(
    openCantripOsPackageResult(f.summary, f.options),
  ).rejects.toThrow("Unlock encryption");
});
it("rejects changed target/operation ownership and misleading public artifact or configuration metadata", async () => {
  const f = await fixture();
  for (const field of [
    "instanceId",
    "attachmentGeneration",
    "targetGeneration",
    "operationId",
  ] as const)
    await expect(
      openCantripOsPackageResult({ ...f.summary, [field]: id(9) }, f.options),
    ).rejects.toThrow("could not be authenticated");
  await expect(
    openCantripOsPackageResult({ ...f.summary, workerId: "other" }, f.options),
  ).rejects.toThrow("could not be authenticated");
  await expect(
    openCantripOsPackageResult(
      { ...f.summary, configuration: "package-defaults" },
      f.options,
    ),
  ).rejects.toThrow("could not be authenticated");
  await expect(
    openCantripOsPackageResult(
      {
        ...f.summary,
        packages: [{ ...f.summary.packages[0]!, version: "9.0" }],
      },
      f.options,
    ),
  ).rejects.toThrow("could not be authenticated");
});
it("withholds a completed decrypt if encryption locks during key access", async () => {
  const f = await fixture(),
    componentKey = f.service.componentKey.bind(f.service);
  vi.spyOn(f.service, "componentKey").mockImplementationOnce((input) => {
    const key = componentKey(input);
    f.service.lock();
    return key;
  });
  await expect(
    openCantripOsPackageResult(f.summary, f.options),
  ).rejects.toThrow("could not be authenticated");
});
