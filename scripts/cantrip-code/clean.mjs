import { rm } from "node:fs/promises";
import path from "node:path";
import { codeBuildRoot, codeCacheRoot, codeRoot, root } from "./lib.mjs";

for (const directory of [
  codeBuildRoot,
  codeCacheRoot,
  path.join(codeRoot, ".prepared"),
  path.join(codeRoot, "artifacts"),
]) {
  await rm(directory, { recursive: true, force: true });
  console.log(`Removed ${path.relative(root, directory)}`);
}
