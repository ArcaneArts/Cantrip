import { createNbtPageCipher } from "./cipher.js";
import { EncryptedNbtPageCache } from "./cache.js";
import { openNbtPageStore } from "./fallback.js";
import type { NbtPageStore } from "./types.js";

/** Owns its cipher and backing store. Bind the scope to account, document and revision. */
export async function openEncryptedNbtCache(
  binding: string,
  options: {
    id?: string;
    memoryBytes?: number;
    budgetBytes?: number;
    key?: CryptoKey;
    factories?: Array<() => Promise<NbtPageStore>>;
  } = {},
) {
  const cipher = await createNbtPageCipher(binding, options.key);
  let store: NbtPageStore | undefined;
  try {
    store = await openNbtPageStore(options);
    return new EncryptedNbtPageCache(store, cipher, options.budgetBytes);
  } catch (error) {
    cipher.dispose?.();
    await store?.close(true).catch(() => {});
    throw error;
  }
}
