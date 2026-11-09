import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export async function readRustServerSources(root) {
  async function visit(relative) {
    const entries = await readdir(path.join(root, relative), {
      withFileTypes: true,
    });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const file = relative + "/" + entry.name;
        if (entry.isDirectory()) return visit(file);
        return entry.isFile() && entry.name.endsWith(".rs")
          ? [
              {
                file,
                sourceText: await readFile(path.join(root, file), "utf8"),
              },
            ]
          : [];
      }),
    );
    return files.flat();
  }
  return (await visit("cantrip_server_rs/src")).sort((a, b) =>
    a.file.localeCompare(b.file),
  );
}
