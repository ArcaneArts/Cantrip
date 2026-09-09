import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { clearSensitiveBytes, bytesEqual } from "./bytes.js";
import { deriveFieldKey } from "./kdf.js";
import { decryptPayload, encryptPayload } from "./payload.js";
import {
  encryptionAssociatedDataSchema,
  nativeSettingsSnapshotContextSchema,
  nativeModelAttributionSchema,
  type NativeModelAttribution,
  protectedNativeSettingsSnapshotSchema,
  type NativeSettingsSnapshotContext,
  type ProtectedNativeSettingsSnapshot,
} from "@cantrip/protocol";
import {
  nativeThreadSettingsSchema,
  type NativeThreadSettings,
} from "@cantrip/protocol";
interface SnapshotKey {
  ownerId: string;
  serverId: string;
  componentKey: Uint8Array;
  keyRevision: number;
}
const encoder = new TextEncoder();

// Native read and notification objects need not use the same property order.
// The schema below validates JSON first, including every preserved future field.
function canonical(value: unknown): string {
  if (value === undefined)
    throw new Error("Settings fingerprint requires JSON.");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

function material(input: SnapshotKey, value: NativeSettingsSnapshotContext) {
  const context = nativeSettingsSnapshotContextSchema.parse(value);
  const associatedData = encryptionAssociatedDataSchema.parse({
    ownerId: input.ownerId,
    component: "chat-content",
    table: "native-settings-state",
    rowId: bytesToHex(
      sha256(
        encoder.encode(canonical({ serverId: input.serverId, ...context })),
      ),
    ),
    field: "snapshot",
    formatVersion: 1,
    keyRevision: input.keyRevision,
  });
  return {
    associatedData,
    key: deriveFieldKey({
      componentKey: input.componentKey,
      ownerId: input.ownerId,
      component: associatedData.component,
      table: associatedData.table,
      field: associatedData.field,
      keyRevision: input.keyRevision,
    }),
  };
}

function fingerprint(
  key: Uint8Array,
  associatedData: unknown,
  plaintext: Uint8Array,
): string {
  return bytesToHex(
    hmac
      .create(sha256, key)
      .update(encoder.encode(canonical(associatedData)))
      .update(plaintext)
      .digest(),
  );
}

function modelAttributionFingerprint(
  key: Uint8Array,
  associatedData: unknown,
  contentFingerprint: string,
  selection: NativeModelAttribution,
): string {
  return fingerprint(
    key,
    { domain: "native-model-attribution", associatedData },
    encoder.encode(canonical({ contentFingerprint, selection })),
  );
}

function settingsForContext(
  context: NativeSettingsSnapshotContext,
  value: unknown,
): NativeThreadSettings {
  const settings = nativeThreadSettingsSchema.parse(value);
  if (
    !settings.settingsVersion ||
    settings.settingsVersion.epoch !== context.settingsVersion.epoch ||
    settings.settingsVersion.revision !== context.settingsVersion.revision
  )
    throw new Error(
      "Native settings snapshot does not match its declared version.",
    );
  return settings;
}

/** Fresh ciphertext may differ between delivery attempts; the keyed fingerprint
 * identifies equal content at the same native version without disclosing it. */
export async function encryptNativeSettingsSnapshot(
  input: SnapshotKey & {
    context: NativeSettingsSnapshotContext;
    settings: unknown;
    modelAttribution?: NativeModelAttribution;
  },
): Promise<ProtectedNativeSettingsSnapshot> {
  const context = nativeSettingsSnapshotContextSchema.parse(input.context);
  const settings = settingsForContext(context, input.settings);
  const { key, associatedData } = material(input, context);
  const plaintext = new TextEncoder().encode(canonical(settings));
  try {
    const contentFingerprint = fingerprint(key, associatedData, plaintext);
    const selection =
      input.modelAttribution === undefined
        ? undefined
        : nativeModelAttributionSchema.parse(input.modelAttribution);
    return protectedNativeSettingsSnapshotSchema.parse({
      context,
      contentFingerprint,
      ...(selection
        ? {
            modelAttribution: {
              selection,
              fingerprint: modelAttributionFingerprint(
                key,
                associatedData,
                contentFingerprint,
                selection,
              ),
            },
          }
        : {}),
      protectedContent: await encryptPayload({
        key,
        plaintext,
        associatedData,
      }),
    });
  } finally {
    clearSensitiveBytes(plaintext);
    clearSensitiveBytes(key);
  }
}

export async function decryptNativeSettingsSnapshot(
  input: SnapshotKey & {
    context: NativeSettingsSnapshotContext;
    snapshot: ProtectedNativeSettingsSnapshot;
  },
): Promise<NativeThreadSettings> {
  const context = nativeSettingsSnapshotContextSchema.parse(input.context);
  const snapshot = protectedNativeSettingsSnapshotSchema.parse(input.snapshot);
  if (canonical(context) !== canonical(snapshot.context))
    throw new Error("Native settings snapshot belongs to another context.");
  if (input.keyRevision !== snapshot.protectedContent.keyRevision)
    throw new Error("Native settings key revision does not match.");
  const { key, associatedData } = material(input, context);
  try {
    const plaintext = await decryptPayload({
      key,
      associatedData,
      envelope: snapshot.protectedContent,
    });
    try {
      const actual = hexToBytes(fingerprint(key, associatedData, plaintext));
      const expected = hexToBytes(snapshot.contentFingerprint);
      if (!bytesEqual(actual, expected))
        throw new Error("Native settings content fingerprint does not match.");
      if (
        snapshot.modelAttribution &&
        !bytesEqual(
          hexToBytes(snapshot.modelAttribution.fingerprint),
          hexToBytes(
            modelAttributionFingerprint(
              key,
              associatedData,
              snapshot.contentFingerprint,
              snapshot.modelAttribution.selection,
            ),
          ),
        )
      )
        throw new Error("Native model attribution fingerprint does not match.");
      return settingsForContext(
        context,
        JSON.parse(new TextDecoder().decode(plaintext)),
      );
    } finally {
      clearSensitiveBytes(plaintext);
    }
  } finally {
    clearSensitiveBytes(key);
  }
}
