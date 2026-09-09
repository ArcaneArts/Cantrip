import { describe, expect, it } from "vitest";
import {
  encryptionAssociatedDataSchema,
  type NativeSettingsPatch,
} from "@cantrip/protocol";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  decryptNativeSettingsPatch,
  encryptNativeSettingsPatch,
} from "../src/native-settings-update.js";
import { deriveFieldKey } from "../src/kdf.js";
import { encryptPayload } from "../src/payload.js";
import { clearSensitiveBytes } from "../src/bytes.js";

const material = () => ({
  ownerId: "owner-1",
  serverId: "server-1",
  componentKey: new Uint8Array(32).fill(7),
  keyRevision: 2,
  context: {
    chatId: "chat-1",
    operationId: "operation-1",
    bindingId: "binding-1",
  },
});

// Independently form an authenticated envelope to exercise validation after
// decryption, which cannot be tested using the validating encrypt helper.
async function authenticatedPayload(
  value: unknown,
  domain = { table: "native-settings-update", field: "patch" },
) {
  const input = material();
  const associatedData = encryptionAssociatedDataSchema.parse({
    ownerId: input.ownerId,
    component: "chat-content",
    ...domain,
    rowId: bytesToHex(
      sha256(
        new TextEncoder().encode(
          JSON.stringify(["server-1", "chat-1", "operation-1", "binding-1"]),
        ),
      ),
    ),
    formatVersion: 1,
    keyRevision: input.keyRevision,
  });
  const key = deriveFieldKey({
    componentKey: input.componentKey,
    ownerId: input.ownerId,
    component: associatedData.component,
    ...domain,
    keyRevision: input.keyRevision,
  });
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  try {
    return await encryptPayload({ key, plaintext, associatedData });
  } finally {
    clearSensitiveBytes(key);
    clearSensitiveBytes(plaintext);
  }
}

describe("explicit native settings patch encryption", () => {
  it.each<NativeSettingsPatch>([
    { model: "model-a" },
    { serviceTier: null },
    { serviceTier: "fast" },
    {
      effort: "high",
      approvalPolicy: { reject: { sandbox_approval: true } },
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "model-a",
          reasoning_effort: null,
          developer_instructions: "private instructions",
        },
      },
    },
  ])(
    "preserves explicit values without filling omitted settings: %j",
    async (patch) => {
      const input = material();
      const envelope = await encryptNativeSettingsPatch({ ...input, patch });
      const opened = await decryptNativeSettingsPatch({ ...input, envelope });
      expect(opened).toEqual(patch);
      expect(Object.hasOwn(opened, "serviceTier")).toBe(
        Object.hasOwn(patch, "serviceTier"),
      );
      expect(input.componentKey).toEqual(material().componentKey);
    },
  );

  it("binds the owner, server, chat, operation, native binding and key revision", async () => {
    const input = material();
    const envelope = await encryptNativeSettingsPatch({
      ...input,
      patch: { model: "model-a" },
    });
    for (const alteration of [
      { ownerId: "owner-2" },
      { serverId: "server-2" },
      { context: { ...input.context, chatId: "chat-2" } },
      { context: { ...input.context, operationId: "operation-2" } },
      { context: { ...input.context, bindingId: "binding-2" } },
      { keyRevision: 3 },
      { componentKey: new Uint8Array(32).fill(8) },
    ]) {
      await expect(
        decryptNativeSettingsPatch({ ...input, ...alteration, envelope }),
      ).rejects.toThrow();
    }
    // Failed authentication does not erase the caller's reusable component key.
    expect(input.componentKey).toEqual(material().componentKey);
  });

  it("rejects unknown or invalid fields before encryption", async () => {
    for (const patch of [
      { model: 42 },
      { developerInstructions: "injected" },
    ]) {
      await expect(
        encryptNativeSettingsPatch({
          ...material(),
          patch: patch as unknown as NativeSettingsPatch,
        }),
      ).rejects.toThrow();
    }
  });

  it.each([{ model: 42 }, { unexpectedField: "injected" }])(
    "rejects authenticated invalid patch content: %j",
    async (patch) => {
      const envelope = await authenticatedPayload(patch);
      await expect(
        decryptNativeSettingsPatch({ ...material(), envelope }),
      ).rejects.toThrow();
    },
  );

  it("cannot authenticate content from the observation snapshot domain", async () => {
    const envelope = await authenticatedPayload(
      { model: "model-a" },
      { table: "native-settings-state", field: "snapshot" },
    );
    await expect(
      decryptNativeSettingsPatch({ ...material(), envelope }),
    ).rejects.toThrow();
  });
});
