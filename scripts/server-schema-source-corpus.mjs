import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

export async function readServerSchemaSourceCorpus(repositoryRoot) {
  const directory = resolve(
    repositoryRoot,
    "tests/reference-node-server/src/db",
  );
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(
      (entry) => entry.isFile() && /^schema(?:-.*)?\.ts$/u.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
  return Promise.all(
    files.map(async (name) => ({
      file: `tests/reference-node-server/src/db/${name}`,
      sourceText: await readFile(resolve(directory, name), "utf8"),
    })),
  );
}
