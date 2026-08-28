import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readApplicationSourceCorpus,
  sourceLineCount,
} from "./application-source-corpus.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const applicationFacade = "cantrip_server/src/app.ts";
const applicationCompositionRoot = "cantrip_server/src/app/build-app.ts";
const applicationFacadeMaximum = 200;
const applicationCompositionRootMaximum = 1_500;
const applicationModuleMaximum = 1_999;
const sources = await readApplicationSourceCorpus(repositoryRoot);
const failures = [];

for (const { file, sourceText } of sources) {
  const lines = sourceLineCount(sourceText);
  const maximum =
    file === applicationFacade
      ? applicationFacadeMaximum
      : file === applicationCompositionRoot
        ? applicationCompositionRootMaximum
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
