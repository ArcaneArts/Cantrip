import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readServerRepositorySourceCorpus,
  serverRepositoryLineBudgetFailures,
} from "./server-repository-source-corpus.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sources = await readServerRepositorySourceCorpus(repositoryRoot);
const failures = serverRepositoryLineBudgetFailures(sources);

if (failures.length > 0) {
  console.error("Cantrip server repository line budgets were exceeded:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Server repository line budgets pass for ${sources.length} source file${sources.length === 1 ? "" : "s"}`,
  );
}
