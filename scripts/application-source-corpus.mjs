import { readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

async function typescriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    },
  );
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return typescriptFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return nested.flat().sort();
}

const normalizePath = (path) => path.split(sep).join("/");

export async function applicationSourcePaths(repositoryRoot) {
  const serverSourcePath = resolve(repositoryRoot, "cantrip_server/src");
  return [
    resolve(serverSourcePath, "app.ts"),
    ...(await typescriptFiles(resolve(serverSourcePath, "app"))),
  ];
}

export async function readApplicationSourceCorpus(repositoryRoot) {
  return Promise.all(
    (await applicationSourcePaths(repositoryRoot)).map(async (path) => ({
      file: normalizePath(relative(repositoryRoot, path)),
      sourceText: await readFile(path, "utf8"),
    })),
  );
}

export function combineApplicationSources(sources) {
  return sources
    .map(
      ({ file, sourceText }) => `// Application source: ${file}\n${sourceText}`,
    )
    .join("\n");
}

export function sourceLineCount(sourceText) {
  if (sourceText.length === 0) return 0;
  return sourceText.split("\n").length - (sourceText.endsWith("\n") ? 1 : 0);
}
