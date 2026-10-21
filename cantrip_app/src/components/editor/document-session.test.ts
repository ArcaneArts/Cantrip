import { describe, expect, it } from "vitest";
import {
  EditorDocumentSession,
  EditorSessionStore,
  editorDocumentId,
  textFileFormat,
} from "./document-session";
import { EditorInputHistory, indentationChange } from "./input-history";
import { EditorLineIndex, editorViewport } from "./viewport";
import { isCurrentHighlight } from "./syntax/worker-protocol";

describe("endpoint document sessions", () => {
  it("isolates all placement and identity dimensions", () => {
    const identity = {
      server: "s",
      account: "a",
      worker: "w",
      project: "p",
      worktree: "t",
      path: "file.ts",
    };
    const keys = Object.keys(identity) as (keyof typeof identity)[];
    expect(
      new Set([
        editorDocumentId(identity),
        ...keys.map((key) =>
          editorDocumentId({ ...identity, [key]: "different" }),
        ),
      ]).size,
    ).toBe(7);
  });
  it("retains dirty drafts on refresh and evicts only clean sessions", () => {
    const store = new EditorSessionStore(1);
    const first = store.open("first", "old", "v1");
    first.edit("draft");
    store.open("first", "external", "v2");
    expect(first.text).toBe("draft");
    expect(first.version).toBe("v1");
    store.open("second", "second", "v1");
    store.open("third", "third", "v1");
    expect(store.get("second")).toBeUndefined();
    expect(store.get("first")).toBe(first);
    expect(store.close("first")).toBe(false);
  });
  it("coalesces overlapping saves and keeps later typing dirty", async () => {
    const session = new EditorDocumentSession("id", "old", "v1");
    session.edit("first");
    let complete!: (result: { version: string }) => void;
    const calls: unknown[] = [];
    const write = (input: unknown) => {
      calls.push(input);
      return new Promise<{ version: string }>((resolve) => {
        complete = resolve;
      });
    };
    const pending = session.save(write);
    expect(session.save(write)).toBe(pending);
    await Promise.resolve();
    session.edit("second");
    complete({ version: "v2" });
    await pending;
    expect(calls).toEqual([{ content: "first", version: "v1" }]);
    expect(session.baseline).toBe("first");
    expect(session.text).toBe("second");
    expect(session.dirty).toBe(true);
    await session.save(async (input) => {
      expect(input).toEqual({ content: "second", version: "v2" });
      return { version: "v3" };
    });
    expect(session.dirty).toBe(false);
  });
  it("retains the loaded version and draft after a save conflict", async () => {
    const session = new EditorDocumentSession("id", "old", "v1");
    session.edit("draft");
    await expect(
      session.save(async () => {
        throw new Error("conflict");
      }),
    ).rejects.toThrow("conflict");
    session.reconcile("external", "v2");
    expect(session.version).toBe("v1");
    expect(session.text).toBe("draft");
    expect(session.dirty).toBe(true);
  });
  it("preserves BOM and CRLF through textarea normalization", async () => {
    const session = new EditorDocumentSession(
      "id",
      "\uFEFFfirst\r\nsecond\r\n",
      "v1",
    );
    expect(session.text).toBe("first\nsecond\n");
    session.edit("first\nchanged\n");
    await session.save(async ({ content }) => {
      expect(content).toBe("\uFEFFfirst\r\nchanged\r\n");
      return { version: "v2" };
    });
    expect(session.dirty).toBe(false);
  });
  it("round-trips mixed newline conventions without edits", () => {
    const content = "a\r\nb\nc\rd";
    const format = textFileFormat(content);
    expect(format.encode(format.text)).toBe(content);
  });
  it("preserves untouched mixed endings when inserting a line", () => {
    const format = textFileFormat("a\r\nb\nc\rd");
    expect(format.encode("a\ninsert\nb\nc\nd")).toBe("a\r\ninsert\r\nb\nc\rd");
  });
});

describe("owned input and viewport state", () => {
  it("accepts a large multiline paste without overflowing argument limits", () => {
    const index = new EditorLineIndex("before\nafter");
    const next = "before\n" + "pasted\n".repeat(150000) + "after";
    index.update(next);
    expect(index.lines).toHaveLength(150002);
    expect(index.lines.at(-1)).toBe("after");
  });
  it("undoes and redoes Unicode edits with their selections", () => {
    const history = new EditorInputHistory();
    const before = { start: 0, end: 0, direction: "none" as const },
      after = { start: 4, end: 4, direction: "none" as const };
    history.record("", "😀é", before, after);
    expect(history.undo("😀é")).toEqual({ text: "", selection: before });
    expect(history.redo("")).toEqual({ text: "😀é", selection: after });
    history.undo("😀é");
    history.record("", "new", before, after);
    expect(history.redo("new")).toBeNull();
  });
  it("indents a selection without touching the next unselected line", () => {
    expect(indentationChange("a\nb\nc", 0, 4, false)).toEqual({
      change: { from: 0, to: 3, insert: "  a\n  b" },
      selection: { start: 2, end: 8, direction: "none" },
    });
    expect(indentationChange("  a\n\tb", 0, 6, true).change.insert).toBe(
      "a\nb",
    );
  });
  it("keeps only visible lines plus overscan, including a trailing empty line", () => {
    expect(editorViewport(24012, 480, 100000)).toEqual({
      first: 992,
      last: 1029,
    });
    const index = new EditorLineIndex("first\nlast\n");
    index.update("first\nnew\nlast\n");
    expect(index.lines).toEqual(["first", "new", "last", ""]);
    expect(index.offsets).toEqual([0, 6, 10, 15]);
    index.update("");
    expect(index.lines).toEqual([""]);
  });
  it("rejects stale worker responses by document, revision, and viewport", () => {
    const response = { documentId: "file", revision: 3, first: 10, lines: [] };
    expect(isCurrentHighlight(response, "file", 3, 10)).toBe(true);
    expect(isCurrentHighlight(response, "other", 3, 10)).toBe(false);
    expect(isCurrentHighlight(response, "file", 4, 10)).toBe(false);
    expect(isCurrentHighlight(response, "file", 3, 20)).toBe(false);
  });
});
