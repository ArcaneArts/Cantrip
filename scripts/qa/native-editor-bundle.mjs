import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const app = path.join(root, "cantrip_app");
const requireApp = createRequire(path.join(app, "package.json"));
const { build } = await import(requireApp.resolve("vite"));
const directory = path.join(root, ".qa/native-editor-bundle");
const chunks = [];
function attribution(scope) {
  return {
    name: `native-editor-module-attribution-${scope}`,
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        const code = chunk.type === "chunk" ? chunk.code : chunk.source;
        const modules =
          chunk.type === "chunk"
            ? Object.entries(chunk.modules).map(([id, info]) => ({
                path: path.relative(root, id),
                renderedCharacters: info.renderedLength,
                ownedEditor:
                  id.includes("/src/components/editor/") &&
                  !id.includes("/qa/"),
              }))
            : [];
        chunks.push({
          scope,
          file: chunk.fileName,
          rawBytes: Buffer.byteLength(code),
          gzipBytes: gzipSync(code).length,
          modules,
        });
      }
    },
  };
}
await mkdir(directory, { recursive: true });
await build({
  root: app,
  configFile: path.join(app, "vite.config.ts"),
  plugins: [attribution("client")],
  worker: { plugins: () => [attribution("worker")] },
  build: { outDir: path.join(directory, "dist"), emptyOutDir: true },
});
const report = {
  note: "Raw/gzip bytes describe complete emitted chunks. assets deduplicates worker files also emitted by the client build. renderedCharacters attributes module output before final chunk minification; it is not independently gzippable or an incremental download estimate. Shared chunk names do not establish editor cost.",
  assets: [
    ...new Map(
      chunks.map(({ file, rawBytes, gzipBytes }) => [
        file,
        { file, rawBytes, gzipBytes },
      ]),
    ).values(),
  ],
  ownedModules: chunks.flatMap((chunk) =>
    chunk.modules
      .filter((module) => module.ownedEditor)
      .map((module) => ({ scope: chunk.scope, chunk: chunk.file, ...module })),
  ),
  chunks,
};
await writeFile(
  path.join(directory, "report.json"),
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify(
    {
      report: path.join(directory, "report.json"),
      ownedModules: report.ownedModules,
    },
    null,
    2,
  ),
);
