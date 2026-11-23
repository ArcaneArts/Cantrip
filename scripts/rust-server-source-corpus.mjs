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
  const crates = await readdir(path.join(root, "crates"), {
    withFileTypes: true,
  });
  const roots = [
    "cantrip_server/src",
    ...crates
      .filter((entry) => entry.isDirectory())
      .map((entry) => `crates/${entry.name}/src`),
  ];
  return (await Promise.all(roots.map(visit)))
    .flat()
    .sort((a, b) => a.file.localeCompare(b.file));
}
