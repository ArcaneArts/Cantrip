import {
  nativeResourceProtectionRequestSchema,
  type NativeResourceProtection,
  type NativeResourceComponent,
} from "../native-resource-protection.js";

interface ResourceControlPorts {
  owner(request: { threadId: string; runnerGeneration: string }): {
    transport: string;
    runner: string;
    component?: NativeResourceComponent;
  } | null;
  protection: NativeResourceProtection | null;
  resolve(params: unknown): Promise<unknown>;
}

/** Private connection-owned data bridge. Never publish its input to observers. */
export async function handleNativeResourceProtection(
  raw: unknown,
  ports: ResourceControlPorts,
): Promise<void> {
  const request = nativeResourceProtectionRequestSchema.parse(raw);
  const owner = ports.owner(request);
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
      ? owner.component === "task-content"
        ? await ports.protection.seal(binding, request.value, owner.component)
        : await ports.protection.seal(binding, request.value)
      : owner.component === "task-content"
        ? await ports.protection.open(binding, request.value, owner.component)
        : await ports.protection.open(binding, request.value);
  } catch {
    // Explicit denial. Errors and private values never enter diagnostic payloads.
  }
  const current = ports.owner(request);
  if (
    !current ||
    current.transport !== owner.transport ||
    current.runner !== owner.runner ||
    (current.component ?? "chat-content") !==
      (owner.component ?? "chat-content")
  )
    return;
  await ports.resolve({
    ...binding,
    runnerGeneration: request.runnerGeneration,
    requestId: request.requestId,
    value,
  });
}
