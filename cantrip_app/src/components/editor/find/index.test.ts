import { expect, it } from "vitest";
import { FindIndex } from "./index";
it("counts literal case-insensitive matches and starts at or after the caret", () => {
  const find = new FindIndex("One one\nONE", "one", 4);
  expect(find.result(7)).toEqual({
    requestId: 7,
    count: 3,
    index: 1,
    match: { from: 4, to: 7 },
  });
  find.move(1);
  expect(find.current()).toEqual({ from: 8, to: 11 });
  find.move(1);
  expect(find.index).toBe(0);
  find.move(-1);
  expect(find.index).toBe(2);
});
it.each(["[", "]", ".*", "$", "^", "\\", "a+b", "(a)", "x?", "{1}", "|"])(
  "escapes literal query %s",
  (query) => {
    const find = new FindIndex(`first ${query} end ${query}`, query);
    expect(find.count).toBe(2);
    expect(find.current()).toEqual({ from: 6, to: 6 + query.length });
  },
);
it("preserves UTF-16 selection offsets for Unicode text and case folding", () => {
  const find = new FindIndex("😀 X 😀 x", "x");
  expect(find.current()).toEqual({ from: 3, to: 4 });
  find.move(1);
  expect(find.current()).toEqual({ from: 8, to: 9 });
  const emoji = new FindIndex("😀 😀", "😀", 1);
  expect(emoji.current()).toEqual({ from: 3, to: 5 });
  expect(new FindIndex("ſ S s", "s").count).toBe(3);
});
it("handles empty, missing, multiline and non-overlapping queries", () => {
  for (const query of ["", "missing"])
    expect(new FindIndex("text", query).result(1)).toEqual({
      requestId: 1,
      count: 0,
      index: -1,
      match: null,
    });
  expect(new FindIndex("aaa", "aa").count).toBe(1);
  expect(new FindIndex("ab\nab", "b\na").current()).toEqual({ from: 1, to: 4 });
  expect(new FindIndex("same same", "same", 100).index).toBe(0);
});
it("navigates densely matching large text, wraps, and handles rapid queued steps", () => {
  const find = new FindIndex("x".repeat(2_000_000), "x");
  expect(find.count).toBe(2_000_000);
  find.move(-1);
  expect(find.current()).toEqual({ from: 1_999_999, to: 2_000_000 });
  find.move(1000);
  expect(find.index).toBe(999);
  expect(find.current()).toEqual({ from: 999, to: 1000 });
  find.move(-2_001_000);
  expect(find.index).toBe(1_999_999);
});
