import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readApplicationSourceCorpus,
  sourceLineCount,
} from "./application-source-corpus.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const legacyEntrypoint = "cantrip_server/src/app.ts";
// Ratchet this downward as each extraction lands; remove the legacy exception
// once app.ts becomes the final compatibility facade.
const legacyEntrypointMaximum = 19_021;
const applicationModuleMaximum = 1_999;
const sources = await readApplicationSourceCorpus(repositoryRoot);
const failures = [];

for (const { file, sourceText } of sources) {
  const lines = sourceLineCount(sourceText);
  const maximum =
    file === legacyEntrypoint
      ? legacyEntrypointMaximum
      : applicationModuleMaximum;
  if (lines > maximum)
    failures.push(`${file}: ${lines} lines (maximum ${maximum})`);
}

if (failures.length > 0) {
  console.error(
    "Cantrip application decomposition line budgets were exceeded:",
  );
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Application decomposition line budgets pass for ${sources.length} source file${sources.length === 1 ? "" : "s"}`,
  );
}
