import { describe, expect, it, vi } from "vitest";
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
  it("keeps structured edits in the same undo history without duplicating native edits", () => {
    const session = new EditorDocumentSession("file", "original", "v1");
    session.history.record(
      session.text,
      "native edit",
      session.selection,
      session.selection,
    );
    session.edit("native edit");
    session.editExternal("native edit");
    session.editExternal("visual edit");
    expect(session.history.undo(session.text)?.text).toBe("native edit");
    expect(session.history.undo("native edit")?.text).toBe("original");
    expect(session.history.undo("original")).toBeNull();
  });
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
  it("serializes explicit saves of newer text while leaving subsequent typing unsaved", async () => {
    const session = new EditorDocumentSession("id", "original", "v1");
    let complete!: (value: { version: string }) => void;
    const calls: { content: string; version: string }[] = [];
    session.edit("first");
    const first = session.save(async (input) => {
      calls.push(input);
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    await Promise.resolve();
    session.edit("second");
    const second = session.save(async (input) => {
      calls.push(input);
      return { version: "v3" };
    });
    session.edit("third typed without saving");
    expect(calls).toHaveLength(1);
    complete({ version: "v2" });
    await Promise.all([first, second]);
    expect(calls).toEqual([
      { content: "first", version: "v1" },
      { content: "second", version: "v2" },
    ]);
    expect(session.baseline).toBe("second");
    expect(session.text).toBe("third typed without saving");
    expect(session.dirty).toBe(true);
  });
  it("keeps queued drafts after a conflict and does not dispatch the dependent write", async () => {
    const session = new EditorDocumentSession("id", "original", "v1");
    let fail!: (error: Error) => void;
    session.edit("first");
    const first = session.save(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    await Promise.resolve();
    session.edit("second");
    const write = vi.fn();
    const second = session.save(write);
    fail(new Error("conflict"));
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.map((value) => value.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(write).not.toHaveBeenCalled();
    expect(session.text).toBe("second");
    expect(session.version).toBe("v1");
    expect(session.saving).toBe(false);
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

  it("keeps an undone draft dirty after a write whose acknowledgement fails", async () => {
    const fs = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const directory = await fs.mkdtemp(
      path.join(tmpdir(), "cantrip-editor-ack-"),
    );
    const file = path.join(directory, "file.txt");
    try {
      await fs.writeFile(file, "original");
      const store = new EditorSessionStore(1);
      const session = store.open("id", "original", "v1");
      session.edit("submitted");
      let fail!: (error: Error) => void;
      let wrote!: () => void;
      const written = new Promise<void>((resolve) => {
        wrote = resolve;
      });
      const pending = session.save(async ({ content }) => {
        await fs.writeFile(file, content);
        wrote();
        return new Promise((_resolve, reject) => {
          fail = reject;
        });
      });
      const rejected = expect(pending).rejects.toThrow("acknowledgement lost");
      await written;
      session.edit("original");
      fail(new Error("acknowledgement lost"));
      await rejected;
      expect(await fs.readFile(file, "utf8")).toBe("submitted");
      expect(session.text).toBe("original");
      expect(session.dirty).toBe(true);
      session.reconcile("submitted", "v2");
      store.open("other", "other", "v1");
      store.open("third", "third", "v1");
      expect(store.get("id")).toBe(session);
      expect(session.text).toBe("original");
      expect(session.version).toBe("v1");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("allows an explicit retry of reverted text after a failed save", async () => {
    const session = new EditorDocumentSession("id", "original", "v1");
    session.edit("submitted");
    const pending = session.save(async () => {
      throw new Error("write failed");
    });
    session.edit("original");
    await expect(pending).rejects.toThrow("write failed");
    const retry = vi.fn(async () => ({ version: "v1" }));
    await session.save(retry);
    expect(retry).toHaveBeenCalledWith({ content: "original", version: "v1" });
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
  it("keeps an empty first line intact when outdenting at offset zero", () => {
    const text = "\nnext";
    const outdent = indentationChange(text, 0, 0, true);
    expect(
      text.slice(0, outdent.change.from) +
        outdent.change.insert +
        text.slice(outdent.change.to),
    ).toBe(text);
    const indent = indentationChange(text, 0, text.length, false);
    expect(
      text.slice(0, indent.change.from) +
        indent.change.insert +
        text.slice(indent.change.to),
    ).toBe("  \n  next");
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
