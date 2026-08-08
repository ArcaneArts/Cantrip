import { rm } from "node:fs/promises";
import path from "node:path";

import { cantripCodexDirectory } from "./lib.mjs";

const directory = path.join(cantripCodexDirectory, ".build");
await rm(directory, { force: true, recursive: true });
console.log("Removed cantrip_codex/.build.");
