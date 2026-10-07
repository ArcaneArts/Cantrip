import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ChatFileReferencesResult } from "@cantrip/protocol/surface-stream";

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Resolve only the supplied references; never enumerate a directory's contents. */
export async function chatFileReferences(
  root: string,
  references: readonly string[],
): Promise<ChatFileReferencesResult> {
  const displayRoot = path.resolve(root);
  const canonicalRoot = await realpath(root);
  const entries = await Promise.all(
    references.map(
      async (
        reference,
      ): Promise<ChatFileReferencesResult["entries"][number]> => {
        let resolvedPath = reference;
        try {
          let value = reference
            .trim()
            .replace(/#L\d+(?:C\d+)?$/iu, "")
            .replace(/:\d+(?::\d+)?$/u, "");
          if (/^file:/iu.test(value)) value = fileURLToPath(value);
          value = value.replaceAll("\\", "/");
          resolvedPath = path.resolve(displayRoot, value);
          if (
            !inside(displayRoot, resolvedPath) &&
            !inside(canonicalRoot, resolvedPath)
          ) {
            return { reference, path: resolvedPath, kind: null };
          }
          if (!inside(displayRoot, resolvedPath)) {
            resolvedPath = path.join(
              displayRoot,
              path.relative(canonicalRoot, resolvedPath),
            );
          }
          const canonicalPath = await realpath(resolvedPath);
          if (!inside(canonicalRoot, canonicalPath)) {
            return { reference, path: resolvedPath, kind: null };
          }
          const metadata = await stat(canonicalPath);
          const kind = metadata.isDirectory()
            ? "directory"
            : metadata.isFile()
              ? "file"
              : null;
          return { reference, path: resolvedPath, kind };
        } catch {
          // Missing, deleted, or inaccessible references still appear in the tree.
          return { reference, path: resolvedPath, kind: null };
        }
      },
    ),
  );
  return { root: displayRoot, entries };
}
