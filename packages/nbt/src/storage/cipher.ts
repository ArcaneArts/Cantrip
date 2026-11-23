import { NbtStorageError, type NbtPageCipher } from "./types.js";

/** Nonextractable ephemeral keys suit disposable caches; recovery can inject a vault-bound cipher. */
export async function createNbtPageCipher(
  binding: string,
  key?: CryptoKey,
): Promise<NbtPageCipher> {
  let active: CryptoKey | undefined =
    key ??
    (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]));
  if (active.algorithm.name !== "AES-GCM")
    throw new NbtStorageError("NBT cache requires an AES-GCM key.");
  const aad = (id: string) =>
    new TextEncoder().encode(
      JSON.stringify(["cantrip-nbt-cache", 1, binding, id]),
    );
  return {
    async seal(id, bytes) {
      const key = active;
      if (!key) throw new NbtStorageError("NBT cache cipher is closed.");
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad(id), tagLength: 128 },
        key,
        bytes as Uint8Array<ArrayBuffer>,
      );
      if (active !== key)
        throw new NbtStorageError("NBT cache cipher is closed.");
      const record = new Uint8Array(13 + data.byteLength);
      record[0] = 1;
      record.set(iv, 1);
      record.set(new Uint8Array(data), 13);
      return record;
    },
    async open(id, record) {
      const key = active;
      if (!key) throw new NbtStorageError("NBT cache cipher is closed.");
      if (record.length < 29 || record[0] !== 1)
        throw new NbtStorageError("Invalid encrypted NBT cache page.");
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: record.slice(1, 13),
              additionalData: aad(id),
              tagLength: 128,
            },
            key,
            record.slice(13),
          ),
        );
      } catch {
        throw new NbtStorageError("NBT cache page authentication failed.");
      }
      if (active !== key) {
        bytes.fill(0);
        throw new NbtStorageError("NBT cache cipher is closed.");
      }
      return bytes;
    },
    dispose() {
      active = undefined;
    },
  };
}
