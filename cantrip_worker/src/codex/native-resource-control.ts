import {
  nativeResourceProtectionRequestSchema,
  type NativeResourceProtection,
} from "../native-resource-protection.js";

interface ResourceControlPorts {
  owner(): { transport: string; runner: string } | null;
  protection: NativeResourceProtection | null;
  resolve(params: unknown): Promise<unknown>;
}

/** Private connection-owned data bridge. Never publish its input to observers. */
export async function handleNativeResourceProtection(
  raw: unknown,
  ports: ResourceControlPorts,
): Promise<void> {
  const request = nativeResourceProtectionRequestSchema.parse(raw);
  const owner = ports.owner();
  if (!owner || owner.runner !== request.runnerGeneration) return;
  const binding = {
    threadId: request.threadId,
    turnId: request.turnId,
    checkpointId: request.checkpointId,
  };
  let value: unknown = null;
  try {
    if (!ports.protection)
      throw new Error("Native resource protection is unavailable.");
    value = request.seal
      ? await ports.protection.seal(binding, request.value)
      : await ports.protection.open(binding, request.value);
  } catch {
    // Explicit denial. Errors and private values never enter diagnostic payloads.
  }
  const current = ports.owner();
  if (
    !current ||
    current.transport !== owner.transport ||
    current.runner !== owner.runner
  )
    return;
  await ports.resolve({
    ...binding,
    runnerGeneration: request.runnerGeneration,
    requestId: request.requestId,
    value,
  });
}
