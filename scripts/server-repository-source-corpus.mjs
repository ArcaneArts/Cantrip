import { readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { sourceLineCount } from "./application-source-corpus.mjs";

export const serverRepositoryLineMaximum = 2_000;

const normalizePath = (path) => path.split(sep).join("/");

async function matchingTypescriptFiles(directory, predicate) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    },
  );
  return entries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith(".ts") && predicate(entry.name),
    )
    .map((entry) => resolve(directory, entry.name))
    .sort();
}

export async function serverRepositorySourcePaths(repositoryRoot) {
  const databaseSourcePath = resolve(repositoryRoot, "cantrip_server/src/db");
  return [
    resolve(databaseSourcePath, "repository.ts"),
    resolve(databaseSourcePath, "tab-layouts.ts"),
    ...(await matchingTypescriptFiles(databaseSourcePath, (name) =>
      name.startsWith("repository-facade-"),
    )),
    ...(await matchingTypescriptFiles(
      resolve(databaseSourcePath, "repository"),
      () => true,
    )),
  ].sort();
}

export async function readServerRepositorySourceCorpus(repositoryRoot) {
  return Promise.all(
    (await serverRepositorySourcePaths(repositoryRoot)).map(async (path) => ({
      file: normalizePath(relative(repositoryRoot, path)),
      sourceText: await readFile(path, "utf8"),
    })),
  );
}

export function serverRepositoryLineBudgetFailures(
  sources,
  maximum = serverRepositoryLineMaximum,
) {
  return sources.flatMap(({ file, sourceText }) => {
    const lines = sourceLineCount(sourceText);
    return lines > maximum
      ? [`${file}: ${lines} lines (maximum ${maximum})`]
      : [];
  });
}
