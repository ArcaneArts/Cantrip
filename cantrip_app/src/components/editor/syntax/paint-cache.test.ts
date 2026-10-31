import { expect, it } from "vitest";
import { SyntaxDocument } from "./document";
import { loadLanguage } from "./languages";
import { SyntaxPaintCache } from "./paint-cache";

const catalog = await loadLanguage("typescript");
function fixture(text: string, first = 0, last = 40) {
  const cache = new SyntaxPaintCache(text, 0);
  for (const line of new SyntaxDocument(text, "typescript", catalog).highlight(
    first,
    last,
  ))
    cache.lines.set(line.number, line);
  return cache;
}
function assertCurrent(cache: SyntaxPaintCache) {
  const fresh = new SyntaxDocument(cache.text, "typescript", catalog).highlight(
    0,
    21_000,
  );
  for (const line of cache.lines.values())
    expect(line).toEqual(fresh[line.number - 1]);
}

it("recolors continuous input immediately from a deep worker checkpoint and reuses unaffected rows", () => {
  let text = Array.from(
    { length: 20_000 },
    (_, i) => `const value${i} = 1;`,
  ).join("\n");
  const cache = fixture(text, 2000, 2040);
  const unchanged = cache.lines.get(2010);
  for (let revision = 1; revision <= 20; revision++) {
    text = text.replace("value2002 = ", "value2002 = 2");
    cache.edit(text, revision, catalog);
    expect(
      cache.lines.get(2003)!.tokens.some((token) => token.kind === "keyword"),
    ).toBe(true);
    expect(cache.lines.get(2010)!.tokens).toBe(unchanged!.tokens);
  }
  assertCurrent(cache);
});

it.each([
  [
    "const a = 1;\nconst b = 2;\nconst c = 3;",
    "const a = 1;\n/*\nconst b = 2;\n*/\nconst c = 3;",
  ],
  ["/*\nconst b = 2;\n*/\nconst c = 3;", "\nconst b = 2;\n*/\nconst c = 3;"],
  ["const a = 1;\nconst b = 2;\nconst c = 3;", "const a = 1;const c = 3;"],
  [
    "const a = `start\ncontinued\nend`;",
    "const a = `start\n${1 + 2}\ncontinued\nend`;",
  ],
])(
  "matches worker lexing after inserted/deleted lines and lexical-state changes",
  (text, next) => {
    const cache = fixture(text);
    cache.edit(next, 1, catalog);
    assertCurrent(cache);
  },
);

it("does not accumulate spans during continuous input while the grammar is unavailable", () => {
  const cache = fixture("const value = 1;");
  const count = cache.lines.get(1)!.tokens.length;
  for (let i = 1; i <= 100; i++)
    cache.edit(`const value = ${"1".repeat(i)};`, i, null);
  expect(cache.lines.get(1)!.tokens.length).toBeLessThanOrEqual(count);
});

it("preserves current text and paint when a long line exceeds the foreground budget", () => {
  const text = `const value = "${"a".repeat(100_000)}";`;
  const cache = fixture(text);
  const next = text.replace("aaa", "abba");
  cache.edit(next, 1, catalog);
  expect(cache.lines.get(1)!.text).toBe(next);
  expect(cache.lines.get(1)!.tokens[0]!.kind).toBe("keyword");
  const line = cache.lines.get(1)!;
  expect(
    line.tokens.map((token) => line.text.slice(token.from, token.to)).join(""),
  ).toBe(next);
});

it.each(["constx value = 1;", "const value = 2;", "const = 1;", ""])(
  "cold-grammar token projection paints the current text exactly once (%s)",
  (next) => {
    const cache = fixture("const value = 1;");
    cache.edit(next, 1, null);
    const line = cache.lines.get(1)!;
    expect(
      line.tokens
        .map((token) => line.text.slice(token.from, token.to))
        .join(""),
    ).toBe(next);
  },
);
