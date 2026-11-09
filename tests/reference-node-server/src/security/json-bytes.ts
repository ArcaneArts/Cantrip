import { types } from "node:util";

/** JSON byte accounting must not become free when V8 exhausts its call stack. */
export function serializedJsonBytes(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 0 : Buffer.byteLength(encoded);
  } catch {
    // Wire JSON contains data properties only. Keep the previous zero-byte
    // fallback for unsupported JavaScript values, cycles and custom hooks;
    // never call a getter or toJSON again after a failed serialization.
    try {
      return plainJsonBytes(value) ?? 0;
    } catch {
      return 0;
    }
  }
}

function plainJsonBytes(value: unknown): number | undefined {
  type Frame =
    { value: unknown; leave?: false } | { value: object; leave: true };
  const stack: Frame[] = [{ value }];
  const ancestors = new WeakSet<object>();
  let bytes = 0;
  while (stack.length) {
    const frame = stack.pop()!;
    if (frame.leave) {
      ancestors.delete(frame.value);
      continue;
    }
    const item = frame.value;
    if (
      item === null ||
      ["string", "boolean", "number"].includes(typeof item)
    ) {
      bytes += Buffer.byteLength(JSON.stringify(item));
      continue;
    }
    if (typeof item !== "object") return undefined;
    if (types.isProxy(item)) return undefined;
    const prototype = Object.getPrototypeOf(item);
    const array = Array.isArray(item);
    if (
      prototype !== (array ? Array.prototype : Object.prototype) &&
      prototype !== null
    )
      return undefined;
    for (const target of [item, prototype, Object.prototype]) {
      if (target === null) continue;
      const hook = Object.getOwnPropertyDescriptor(target, "toJSON");
      if (hook && (!("value" in hook) || typeof hook.value === "function"))
        return undefined;
    }
    if (ancestors.has(item)) return undefined;
    ancestors.add(item);
    stack.push({ value: item, leave: true });
    if (array) {
      bytes += 2 + Math.max(0, item.length - 1);
      for (let index = item.length - 1; index >= 0; index--) {
        const descriptor = Object.getOwnPropertyDescriptor(item, index);
        if (!descriptor || !("value" in descriptor)) return undefined;
        stack.push({ value: descriptor.value });
      }
    } else {
      const keys = Object.keys(item);
      bytes += 2 + Math.max(0, keys.length - 1);
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !("value" in descriptor)) return undefined;
        bytes += Buffer.byteLength(JSON.stringify(key)) + 1;
        stack.push({ value: descriptor.value });
      }
    }
  }
  return bytes;
}
