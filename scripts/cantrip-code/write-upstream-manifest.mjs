import { createSourceManifest, upstreamFilesPath, writeJson } from "./lib.mjs";

const manifest = await createSourceManifest();
await writeJson(upstreamFilesPath, manifest);
console.log(`Recorded ${manifest.files.length} upstream files`);
