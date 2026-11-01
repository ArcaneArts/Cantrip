import { createNbtPageCipher } from "@cantrip/nbt/storage";

const maximum = 4 * 1024 ** 2;
const tag = "$cantripNbtWire";
function base64(bytes: Uint8Array) {
  let text = "";
  for (let at = 0; at < bytes.length; at += 8192)
    text += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(text);
}
/** Bounded display/RPC frames only. BigInts, non-finite floats, -0 and binary
 * chunks survive the transport; user tag names/values remain inside ciphertext. */
export async function nbtSharedWire(id: string, key: CryptoKey) {
  const cipher = await createNbtPageCipher("shared-nbt-v1/" + id, key);
  return {
    async seal(value: unknown) {
      const bytes = new TextEncoder().encode(
        JSON.stringify(value, (_key, value) => {
          if (typeof value === "bigint")
            return { [tag]: ["bigint", value.toString()] };
          if (value instanceof Uint8Array)
            return { [tag]: ["bytes", base64(value)] };
          if (
            typeof value === "number" &&
            (!Number.isFinite(value) || Object.is(value, -0))
          )
            return {
              [tag]: ["number", Object.is(value, -0) ? "-0" : String(value)],
            };
          return value;
        }),
      );
      try {
        if (bytes.length > maximum)
          throw new Error("NBT shared-view frame exceeds its page budget.");
        const nonce = crypto.randomUUID();
        return { nonce, bytes: await cipher.seal(nonce, bytes) };
      } finally {
        bytes.fill(0);
      }
    },
    async open(value: unknown): Promise<unknown> {
      if (
        !value ||
        typeof value !== "object" ||
        !("nonce" in value) ||
        !("bytes" in value) ||
        typeof value.nonce !== "string" ||
        !/^[a-f0-9-]{36}$/u.test(value.nonce) ||
        !(value.bytes instanceof Uint8Array) ||
        value.bytes.length > maximum + 29
      )
        throw new Error("Invalid encrypted NBT shared-view frame.");
      const bytes = await cipher.open(value.nonce, value.bytes);
      try {
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          (_key, value) => {
            if (
              !value ||
              typeof value !== "object" ||
              Object.keys(value).length !== 1 ||
              !(tag in value)
            )
              return value;
            const data = value[tag];
            if (
              !Array.isArray(data) ||
              data.length !== 2 ||
              typeof data[1] !== "string"
            )
              throw new Error("Invalid NBT shared scalar.");
            if (data[0] === "bigint" && /^-?[0-9]+$/u.test(data[1]))
              return BigInt(data[1]);
            if (data[0] === "bytes")
              return Uint8Array.from(atob(data[1]), (char) =>
                char.charCodeAt(0),
              );
            if (
              data[0] === "number" &&
              ["-0", "NaN", "Infinity", "-Infinity"].includes(data[1])
            )
              return Number(data[1]);
            throw new Error("Invalid NBT shared scalar.");
          },
        );
      } finally {
        bytes.fill(0);
      }
    },
    close() {
      cipher.dispose?.();
    },
  };
}
