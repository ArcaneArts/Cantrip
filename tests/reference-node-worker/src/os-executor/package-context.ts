import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  cantripOsGuestPackageRequestSchema,
  cantripOsGuestPackageRecordSchema,
  cantripOsPackageCryptoContextSchema,
  type CantripOsPackageOperationCommand,
  type CantripOsGuestPackageRecord,
} from "@cantrip/protocol";

export function packageAdmission(command: CantripOsPackageOperationCommand) {
  return { ...command, mode: "execute" as const };
}
export function packageRequest(command: CantripOsPackageOperationCommand) {
  return cantripOsGuestPackageRequestSchema.parse({
    version: 2,
    operationId: command.operationId,
    scopeKey: createHash("sha256")
      .update(JSON.stringify([command.scope, command.target.generation]))
      .digest("hex"),
    action: command.action,
    configuration: command.configuration,
    expected: {
      ...command.target.expected,
      bootId: command.target.bootId,
      initStart: command.target.initStart,
    },
    packages: command.packages,
  });
}
export function packageCryptoContext(
  command: CantripOsPackageOperationCommand,
) {
  const scope = command.scope;
  return cantripOsPackageCryptoContextSchema.parse({
    ownerId: scope.ownerId,
    serverId: scope.serverId,
    workerId: scope.workerId,
    instanceId: scope.instanceId,
    attachmentGeneration: scope.attachmentGeneration,
    targetGeneration: command.target.generation,
    operationId: command.operationId,
  });
}
export function packageArguments(
  command: CantripOsPackageOperationCommand,
  action: string,
  ...args: string[]
) {
  return ["--expect", JSON.stringify(command.target.expected), action, ...args];
}
export function packageGuest(
  command: CantripOsPackageOperationCommand,
  raw: unknown,
): CantripOsGuestPackageRecord {
  const record = cantripOsGuestPackageRecordSchema.parse(raw);
  if (!isDeepStrictEqual(record.request, packageRequest(command)))
    throw new Error(
      "The guest package journal belongs to a different original admission",
    );
  if (record.state === "ready") {
    const receipt = record.receipt as {
      exitCode?: number;
      configurationPolicy?: string;
      runtimeHandlesRestored?: boolean;
      packages?: Array<{ name: string; exitCode: number; status: string }>;
      helpers?: Array<{ name: string; exitCode: number }>;
    } | null;
    if (
      !receipt ||
      receipt.exitCode !== 0 ||
      receipt.configurationPolicy !== command.configuration ||
      receipt.runtimeHandlesRestored !== false ||
      receipt.packages?.length !== command.packages.length ||
      receipt.helpers?.length !== command.packages.length ||
      command.packages.some(
        (item) =>
          !receipt.packages?.some(
            (actual) =>
              actual.name === item.name &&
              actual.exitCode === 0 &&
              actual.status ===
                `install ok installed\t${item.version}\t${item.architecture}`,
          ) ||
          !receipt.helpers?.some(
            (actual) => actual.name === item.name && actual.exitCode === 0,
          ),
      )
    )
      throw new Error(
        "The guest has no verified package/helper completion receipt",
      );
  }
  return record;
}
