import { expect, it } from "vitest";
import { textChange } from "./document";

it.each([0, 1, 4095, 4096, 4097, 8192, 500_000])(
  "finds the exact UTF-16 edit at offset %s in a large unchanged document",
  (from) => {
    const text = "😀abc".repeat(100_001);
    for (const removed of [0, 1, 4095, 4096]) {
      const to = Math.min(text.length, from + removed);
      const next = text.slice(0, from) + "INSERTED" + text.slice(to);
      expect(textChange(text, next)).toEqual({ from, to, insert: "INSERTED" });
    }
  },
);
