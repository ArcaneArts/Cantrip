import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatScratchFileManager } from "../src/chat-scratch-files.js";
import {
  listExplorerDirectory,
  readExplorerFile,
  writeExplorerFile,
} from "../src/explorer.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
for (const kind of ["Explorer", "Chat"] as const) {
  describe(`${kind} editable file access`, () => {
    async function fixture() {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "cantrip-editor-file-access-"),
      );
      roots.push(root);
      const chat = new ChatScratchFileManager(root);
      return {
        root,
        read: (file: string) =>
          kind === "Explorer"
            ? readExplorerFile(root, file)
            : chat.read(root, file),
        write: (file: string, content: string, version: string) =>
          kind === "Explorer"
            ? writeExplorerFile(root, file, content, version)
            : chat.write(root, file, content, version),
        list: () =>
          kind === "Explorer"
            ? listExplorerDirectory(root, "")
            : chat.list(root, ""),
      };
    }
    it("opens and revision-saves UTF-8 text with an unknown extension", async () => {
      const api = await fixture(),
        file = "source.unlisted-language";
      await writeFile(path.join(api.root, file), "plain text\n");
      expect(
        (await api.list()).entries.find((entry) => entry.path === file)
          ?.viewable,
      ).toBe(true);
      const loaded = await api.read(file);
      expect(loaded.content).toBe("plain text\n");
      await api.write(file, "edited text\n", loaded.version);
      expect(await readFile(path.join(api.root, file), "utf8")).toBe(
        "edited text\n",
      );
    });
    it("retains the UTF-8 BOM and complete CRLF document through read and save", async () => {
      const api = await fixture(),
        file = "bom.txt";
      const original = "\uFEFFfirst\r\nsecond\r\n",
        edited = "\uFEFFfirst\r\nchanged\r\n";
      await writeFile(path.join(api.root, file), original);
      const loaded = await api.read(file);
      expect(loaded.content).toBe(original);
      const saved = await api.write(file, edited, loaded.version);
      expect(saved.content).toBe(edited);
      expect(await readFile(path.join(api.root, file))).toEqual(
        Buffer.from(edited),
      );
    });
    it.each([Buffer.from([0, 1, 2]), Buffer.from([0xff, 0xfe])])(
      "rejects non-text bytes without replacing them",
      async (bytes) => {
        const api = await fixture(),
          file = "unsupported.txt";
        await writeFile(path.join(api.root, file), bytes);
        await expect(api.read(file)).rejects.toThrow(/binary|UTF-8/iu);
        const version = createHash("sha256").update(bytes).digest("hex");
        await expect(api.write(file, "replacement", version)).rejects.toThrow(
          /binary|UTF-8/iu,
        );
        expect(await readFile(path.join(api.root, file))).toEqual(bytes);
      },
    );
  });
}
