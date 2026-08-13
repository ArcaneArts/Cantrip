import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { exists, root, upstreamRoot } from "./lib.mjs";
import { readPatchSeries } from "./patches.mjs";

test("checks Cantrip Code patches against a Windows CRLF checkout", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "cantrip-code-crlf-"));
  try {
    const files = new Set(
      (await readPatchSeries()).flatMap((item) => item.metadata.files),
    );
    for (const relative of files) {
      const upstream = path.join(upstreamRoot, relative);
      if (!(await exists(upstream))) continue;
      const destination = path.join(source, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(upstream, destination);
      const contents = await readFile(destination, "utf8");
      await writeFile(destination, contents.replace(/\r?\n/gu, "\r\n"));
    }

    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "scripts", "cantrip-code", "apply-patches.mjs"),
        "--source",
        source,
        "--check",
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(source, { force: true, recursive: true });
  }
});
