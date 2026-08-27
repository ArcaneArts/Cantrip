import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  combineApplicationSources,
  readApplicationSourceCorpus,
  sourceLineCount,
} from "./application-source-corpus.mjs";

test("application source corpus is deterministic and limited to app modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "cantrip-app-corpus-"));
  try {
    await mkdir(join(root, "cantrip_server/src/app/nested"), {
      recursive: true,
    });
    await writeFile(join(root, "cantrip_server/src/app.ts"), "export {};\n");
    await writeFile(
      join(root, "cantrip_server/src/app/zeta.ts"),
      "export const zeta = true;\n",
    );
    await writeFile(
      join(root, "cantrip_server/src/app/nested/alpha.ts"),
      "export const alpha = true;\n",
    );
    await writeFile(
      join(root, "cantrip_server/src/ignored.ts"),
      "export const ignored = true;\n",
    );

    const corpus = await readApplicationSourceCorpus(root);

    assert.deepEqual(
      corpus.map(({ file }) => file),
      [
        "cantrip_server/src/app.ts",
        "cantrip_server/src/app/nested/alpha.ts",
        "cantrip_server/src/app/zeta.ts",
      ],
    );
    assert.match(combineApplicationSources(corpus), /alpha = true/u);
    assert.doesNotMatch(combineApplicationSources(corpus), /ignored = true/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("source line counts match physical lines", () => {
  assert.equal(sourceLineCount(""), 0);
  assert.equal(sourceLineCount("one"), 1);
  assert.equal(sourceLineCount("one\ntwo\n"), 2);
});
