import { expect, it } from "vitest";
import type { ExplorerTextPreviewPage } from "@cantrip/protocol/surface-stream";
import { TextPreviewDocument } from "./text-preview-document";
const bytes = (s: string) => new TextEncoder().encode(s).length;
function page(
  content: string,
  offset = 0,
  size = 100,
  version = "a".repeat(64),
): ExplorerTextPreviewPage {
  return {
    path: "file.rs",
    content,
    size,
    offset,
    nextOffset: offset + bytes(content),
    eof: offset + bytes(content) === size,
    version,
  };
}
it("appends pages in one read-only session without losing scroll or selection", () => {
  const preview = new TextPreviewDocument("file.rs");
  preview.append(page("\ufeffone\r", 0, bytes("\ufeffone\r\ntwo\r\n😀")));
  const session = preview.session;
  session.scrollTop = 240;
  session.selection = { start: 1, end: 3, direction: "forward" };
  const offset = preview.offset;
  preview.append(page("\ntwo\r\n😀", offset, offset + bytes("\ntwo\r\n😀")));
  expect(preview.session).toBe(session);
  expect(session.text).toBe("one\ntwo\n😀");
  expect(session.scrollTop).toBe(240);
  expect(session.selection).toEqual({ start: 1, end: 3, direction: "forward" });
  expect(session.dirty).toBe(false);
  expect(preview.eof).toBe(true);
});
it.each([
  { path: "other.rs" },
  { offset: 1 },
  { version: "b".repeat(64) },
  { size: 101 },
  { nextOffset: 0 },
  { eof: true },
  { nextOffset: 5 },
])("refuses mismatched or corrupt continuation pages: %j", (patch) => {
  const preview = new TextPreviewDocument("file.rs");
  preview.append(page("one"));
  const previous = preview.session.text;
  expect(() => preview.append({ ...page("two", 3), ...patch })).toThrow(
    "different file or page",
  );
  expect(preview.session.text).toBe(previous);
  expect(preview.offset).toBe(3);
});
it("accepts an empty file and normalizes carriage returns split at byte boundaries", () => {
  const empty = new TextPreviewDocument("file.rs");
  empty.append(page("", 0, 0));
  expect(empty.eof).toBe(true);
  const preview = new TextPreviewDocument("file.rs");
  preview.append(page("one\r", 0, 14));
  preview.append(page("two\r", 4, 14));
  preview.append(page("\nthree", 8, 14));
  expect(preview.session.text).toBe("one\ntwo\nthree");
});
