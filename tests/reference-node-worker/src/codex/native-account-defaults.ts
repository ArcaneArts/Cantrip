import { createHash } from "node:crypto";
import {
  nativeAccountDefaultsSnapshotSchema,
  nativeAccountDefaultsValuesSchema,
  nativeAccountDefaultsWriteSchema,
  type NativeAccountDefaultsSnapshot,
  type NativeAccountDefaultsWrite,
  type NativeAccountDefaultsResult,
} from "@cantrip/protocol";
import { z } from "zod";

type Request = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;
const values = (raw: Record<string, unknown>) =>
  nativeAccountDefaultsValuesSchema.parse(
    Object.fromEntries(
      Object.keys(nativeAccountDefaultsValuesSchema.shape)
        .filter((key) => raw[key] !== undefined)
        .map((key) => [key, raw[key]]),
    ),
  );
const configReadSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  layers: z.array(
    z.object({
      name: z.object({
        type: z.string(),
        profile: z.string().nullable().optional(),
      }),
      version: z.string().min(1),
      config: z.record(z.string(), z.unknown()),
    }),
  ),
});
const writeSchema = z.object({
  status: z.enum(["ok", "okOverridden"]),
  version: z.string().min(1),
});

/** Read the native account layer, not a thread's CLI/project overrides. Never
 * publish the raw config: it can contain instructions, MCP secrets and paths. */
export async function readNativeAccountDefaults(
  request: Request,
): Promise<NativeAccountDefaultsSnapshot> {
  const result = configReadSchema.parse(
    await request("config/read", { includeLayers: true, cwd: null }),
  );
  // Native config/read returns highest precedence first. A selected account
  // file precedes the empty base user layer in a conversation's storage home.
  const user = result.layers.find(
    (layer) => layer.name.type === "user" && layer.name.profile == null,
  );
  return nativeAccountDefaultsSnapshotSchema.parse({
    // Matches pinned config::fingerprint::version_for_toml({}). Native compares
    // it during the real write even when config.toml did not exist.
    version:
      user?.version ??
      `sha256:${createHash("sha256").update("{}").digest("hex")}`,
    stored: values(user?.config ?? {}),
    effective: values(result.config),
  });
}

export function nativeAccountDefaultsParams(value: NativeAccountDefaultsWrite) {
  const input = nativeAccountDefaultsWriteSchema.parse(value);
  return {
    edits: Object.entries(input.values)
      .filter(([, value]) => value !== undefined)
      .map(([keyPath, value]) => ({
        keyPath,
        value,
        mergeStrategy: "replace",
      })),
    expectedVersion: input.expectedVersion,
    reloadUserConfig: false,
  };
}

/** Called inside the admitted dispatch so the durable protected command result
 * contains native write evidence and the subsequent narrowed readback. */
export async function writeNativeAccountDefaults(
  request: Request,
  params: Record<string, unknown>,
  assertCurrent: () => void,
): Promise<NativeAccountDefaultsResult> {
  assertCurrent();
  const write = writeSchema.parse(await request("config/batchWrite", params));
  try {
    assertCurrent();
    const snapshot = await readNativeAccountDefaults(request);
    assertCurrent();
    return {
      write,
      snapshot,
      verification:
        snapshot.version === write.version ? "confirmed" : "changed",
    };
  } catch {
    return { write, snapshot: null, verification: "unavailable" };
  }
}
