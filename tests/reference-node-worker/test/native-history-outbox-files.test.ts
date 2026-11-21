import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureHistoryDirectory } from "../src/native-history-outbox-files.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "native-evidence-directory-"));
  roots.push(root);
  return root;
}

describe("native evidence directory creation", () => {
  it.each(process.platform === "win32" ? [false, true] : [false])(
    "creates writable nested directories (namespaced: %s)",
    async (namespaced) => {
      const root = await fixture();
      const ordinary = path.join(root, "evidence", "owner", "stream");
      const directory = namespaced ? path.toNamespacedPath(ordinary) : ordinary;
      await ensureHistoryDirectory(directory);
      expect((await stat(ordinary)).isDirectory()).toBe(true);
      const filename = path.join(directory, "proof.json");
      await writeFile(filename, "proof");
      expect(await readFile(path.join(ordinary, "proof.json"), "utf8")).toBe(
        "proof",
      );
    },
  );

  it("retains existing directory contents", async () => {
    const root = await fixture();
    const directory = path.join(root, "evidence");
    await ensureHistoryDirectory(directory);
    const filename = path.join(directory, "committed.json");
    await writeFile(filename, "committed");
    await ensureHistoryDirectory(directory);
    expect(await readFile(filename, "utf8")).toBe("committed");
  });

  it("reports a real mkdir failure and preserves the occupying file", async () => {
    const filename = path.join(await fixture(), "occupied");
    await writeFile(filename, "existing");
    await expect(ensureHistoryDirectory(filename)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(filename, "utf8")).toBe("existing");
  });
});
