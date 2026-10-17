import { normalizeSourcePath } from "./application-source-corpus.mjs";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

async function domainSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return domainSources(path);
      return entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !/\.(test|spec)\.ts$/u.test(entry.name)
        ? [path]
        : [];
    }),
  );
  return paths.flat().sort();
}

// Boundary audits inspect implementations and shared request behavior, including
// future nested domains. A compatibility barrel alone cannot establish them.
export async function readClientApiSourceText(repositoryRoot) {
  const paths = [
    resolve(repositoryRoot, "cantrip_app/src/lib/api.ts"),
    resolve(repositoryRoot, "cantrip_app/src/lib/api-client.ts"),
    ...(await domainSources(
      resolve(repositoryRoot, "cantrip_app/src/lib/api"),
    )),
  ];
  return (
    await Promise.all(
      paths.map(
        async (path) =>
          `// Client API source: ${normalizeSourcePath(relative(repositoryRoot, path))}\n${await readFile(path, "utf8")}`,
      ),
    )
  ).join("\n");
}
