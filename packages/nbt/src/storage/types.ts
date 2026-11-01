export const NBT_PAGE_BYTES = 64 * 1024;
export const NBT_MEMORY_BUDGET = 16 * 1024 * 1024;
/** Only ciphertext crosses this interface. Keys are opaque record identifiers. */
export interface NbtPageStore {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, bytes: Uint8Array): Promise<void>;
  keys(): AsyncIterable<string>;
  close(remove?: boolean): Promise<void>;
}
export interface NbtPageCipher {
  seal(key: string, bytes: Uint8Array): Promise<Uint8Array>;
  open(key: string, bytes: Uint8Array): Promise<Uint8Array>;
  dispose?(): void;
}
export class NbtStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NbtStorageError";
  }
}
export function pageKey(key: string) {
  if (!/^[a-zA-Z0-9._:-]{1,180}$/u.test(key))
    throw new NbtStorageError("Invalid NBT cache page identifier.");
  return "page-" + key;
}
export function missing(error: unknown) {
  return error instanceof Error && error.name === "NotFoundError";
}
