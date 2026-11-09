import { describe, expect, it, vi } from "vitest";
import { serializedJsonBytes } from "../src/security/json-bytes.js";

describe("worker JSON byte accounting", () => {
  it("retains actual JSON encoding for ordinary values", () => {
    for (const value of [
      null,
      false,
      -0,
      1e40,
      Infinity,
      "🦀\ud800",
      [],
      { "🦀\ud800": [1, null, false] },
      { "2": 1, "1": 0 },
    ]) {
      expect(serializedJsonBytes(value)).toBe(
        Buffer.byteLength(JSON.stringify(value)),
      );
    }
    expect(serializedJsonBytes(undefined)).toBe(0);
  });
  it("charges deep wire JSON independently of V8 stack limits", () => {
    for (const depth of [10000, 32768]) {
      for (const [open, close] of [
        ["[", "]"],
        ['{"🦀\\ud800":', "}"],
      ]) {
        const wire = open.repeat(depth) + '"🦀\\udfff"' + close.repeat(depth);
        const value: unknown = JSON.parse(wire);
        expect(serializedJsonBytes(value)).toBe(Buffer.byteLength(wire));
      }
    }
  });
  it("counts repeated references without treating them as ancestor cycles", () => {
    const leaf = { opaque: "🦀\ud800" };
    let value: unknown = [leaf, leaf];
    const encodedLeaf = JSON.stringify(value);
    for (let depth = 0; depth < 10000; depth++) value = [value];
    expect(serializedJsonBytes(value)).toBe(
      20000 + Buffer.byteLength(encodedLeaf),
    );
  });
  it("keeps unsupported values and cycles on the original fallback path", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const value of [cyclic, 1n])
      expect(serializedJsonBytes(value)).toBe(0);
    const getter = vi.fn(() => {
      throw new Error("controlled getter failure");
    });
    expect(
      serializedJsonBytes(
        Object.defineProperty({}, "value", { enumerable: true, get: getter }),
      ),
    ).toBe(0);
    expect(getter).toHaveBeenCalledTimes(1);
    const toJSON = vi.fn(() => {
      throw new Error("controlled toJSON failure");
    });
    expect(serializedJsonBytes({ toJSON })).toBe(0);
    expect(toJSON).toHaveBeenCalledTimes(1);
    const hidden = vi.fn(() => {
      throw new Error("controlled non-enumerable hook");
    });
    expect(
      serializedJsonBytes(
        Object.defineProperty({}, "toJSON", { value: hidden }),
      ),
    ).toBe(0);
    expect(hidden).toHaveBeenCalledTimes(1);
    const trap = vi.fn(() => {
      throw new Error("controlled proxy failure");
    });
    expect(serializedJsonBytes(new Proxy({}, { get: trap }))).toBe(0);
    expect(trap).toHaveBeenCalledTimes(1);
  });
});
