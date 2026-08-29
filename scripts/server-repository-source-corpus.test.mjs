import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readServerRepositorySourceCorpus,
  serverRepositoryLineBudgetFailures,
} from "./server-repository-source-corpus.mjs";

test("server repository source corpus covers only repository components", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "cantrip-server-repository-corpus-"),
  );
  try {
    const databasePath = join(root, "cantrip_server/src/db");
    await mkdir(join(databasePath, "repository/nested"), { recursive: true });
    await writeFile(join(databasePath, "repository.ts"), "export {};\n");
    await writeFile(join(databasePath, "tab-layouts.ts"), "export {};\n");
    await writeFile(
      join(databasePath, "repository-facade-projects.ts"),
      "export {};\n",
    );
    await writeFile(join(databasePath, "repository/zeta.ts"), "export {};\n");
    await writeFile(join(databasePath, "repository/alpha.ts"), "export {};\n");
    await writeFile(join(databasePath, "schema.ts"), "export {};\n");
    await writeFile(
      join(databasePath, "repository/nested/ignored.ts"),
      "export {};\n",
    );

    const corpus = await readServerRepositorySourceCorpus(root);

    assert.deepEqual(
      corpus.map(({ file }) => file),
      [
        "cantrip_server/src/db/repository-facade-projects.ts",
        "cantrip_server/src/db/repository.ts",
        "cantrip_server/src/db/repository/alpha.ts",
        "cantrip_server/src/db/repository/zeta.ts",
        "cantrip_server/src/db/tab-layouts.ts",
      ],
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("server repository line budget allows the maximum and reports excess", () => {
  const sources = [
    { file: "at-maximum.ts", sourceText: "one\ntwo\n" },
    { file: "over-maximum.ts", sourceText: "one\ntwo\nthree\n" },
  ];

  assert.deepEqual(serverRepositoryLineBudgetFailures(sources, 2), [
    "over-maximum.ts: 3 lines (maximum 2)",
  ]);
});
