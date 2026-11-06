import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { workerCommandSchema } from "../src/worker-commands.js";
import { cantripOsPackageOperationCommandSchema } from "../src/cantrip-os-packages.js";

function command() {
  const scope = {
    ownerId: "owner",
    workerId: "worker",
    serverId: "server",
    instanceId: randomUUID(),
    guestInstanceId: randomUUID(),
    attachmentGeneration: randomUUID(),
  };
  return {
    type: "cantrip-os.packages.operation" as const,
    mode: "execute" as const,
    operationId: randomUUID(),
    scope,
    transport: {
      kind: "docker" as const,
      container: "exact-selected-instance",
    },
    target: {
      generation: randomUUID(),
      expected: {
        guestInstanceId: scope.guestInstanceId,
        ownerId: scope.ownerId,
        workerId: scope.workerId,
        identityPath: "/var/lib/cantrip-os-executor/instance.json",
      },
      bootId: randomUUID(),
      initStart: "1234",
      architecture: "arm64",
      containerId: "a".repeat(64),
    },
    action: "repair" as const,
    configuration: "preserve" as const,
    packages: [
      {
        name: "cantrip-os-recovery" as const,
        version: "0.5.0",
        architecture: "all",
        sha256: "b".repeat(64),
        bytes: 1234,
      },
    ],
  };
}
describe("independent package administration contracts", () => {
  it("routes through the ordinary Worker command protocol without claiming a live executor runtime", () => {
    const actual = command();
    expect(workerCommandSchema.parse(actual)).toEqual(actual);
    expect(
      workerCommandSchema.safeParse({
        ...actual,
        scope: { ...actual.scope, runtimeGeneration: randomUUID() },
      }).success,
    ).toBe(false);
    expect(
      workerCommandSchema.parse({
        type: "cantrip-os.packages.status",
        scope: actual.scope,
        transport: actual.transport,
      }),
    ).toHaveProperty("scope", actual.scope);
  });
  it("requires explicit repair for conffile replacement and pins an actual init epoch", () => {
    const actual = command();
    expect(
      cantripOsPackageOperationCommandSchema.safeParse({
        ...actual,
        action: "upgrade",
        configuration: "package-defaults",
      }).success,
    ).toBe(false);
    expect(
      cantripOsPackageOperationCommandSchema.safeParse({
        ...actual,
        target: { ...actual.target, initStart: "" },
      }).success,
    ).toBe(false);
    expect(
      cantripOsPackageOperationCommandSchema.safeParse({
        ...actual,
        packages: [...actual.packages, ...actual.packages],
      }).success,
    ).toBe(false);
    expect(
      cantripOsPackageOperationCommandSchema.safeParse({
        ...actual,
        workerPath: "/unadmitted/package.deb",
      }).success,
    ).toBe(false);
  });
});
