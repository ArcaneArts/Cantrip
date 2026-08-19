const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/u;

export function clearSensitiveBytes(bytes: Uint8Array): void {
  bytes.fill(0);
}

export function randomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 1 || length > 65_536) {
    throw new Error("Secure random byte length is out of range.");
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    throw new Error("Value is not canonical unpadded base64url.");
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  } catch {
    throw new Error("Value is not canonical unpadded base64url.");
  }
  const decoded = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
  if (encodeBase64Url(decoded) !== value) {
    throw new Error("Value is not canonical unpadded base64url.");
  }
  return decoded;
}

export function requireByteLength(
  bytes: Uint8Array,
  expectedLength: number,
  label = "Key",
): void {
  if (bytes.byteLength !== expectedLength) {
    throw new Error(`${label} must contain exactly ${expectedLength} bytes.`);
  }
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}
