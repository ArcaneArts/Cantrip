import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  collectSourceFiles,
  prettyJson,
  sourceManifest,
} from "./cantrip-codex/lib.mjs";

const scripts = fileURLToPath(new URL("./cantrip-codex/", import.meta.url));

function patch(before, after) {
  return `diff --git a/sample.txt b/sample.txt
--- a/sample.txt
+++ b/sample.txt
@@ -1 +1 @@
-${before}
+${after}
`;
}

async function fixture(t) {
  const root = await mkdtemp(
    path.join(tmpdir(), "cantrip-codex-verifier-test-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "cantrip_codex", "upstream");
  const patches = path.join(root, "cantrip_codex", "patches");
  const scriptDirectory = path.join(root, "scripts", "cantrip-codex");
  await mkdir(path.join(source, "codex-rs"), { recursive: true });
  await mkdir(patches, { recursive: true });
  await mkdir(scriptDirectory, { recursive: true });
  for (const name of ["lib.mjs", "verify-upstream.mjs", "verify-patches.mjs"]) {
    await cp(path.join(scripts, name), path.join(scriptDirectory, name));
  }
  await writeFile(path.join(source, "sample.txt"), "indexed source\n");
  await writeFile(
    path.join(source, "codex-rs", "Cargo.toml"),
    '[workspace.package]\nversion = "1.2.3"\n',
  );
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git(["init", "--quiet"]);
  git(["add", "cantrip_codex/upstream"]);
  const index = await readFile(path.join(root, ".git", "index"));
  // Deliberately differ from the caller's index. Verification must use the
  // current filesystem whose manifest was actually checked.
  await writeFile(path.join(source, "sample.txt"), "actual source\n");
  const metadata = {
    repository: "https://example.invalid/fixture",
    ref: "fixture",
    commit: "1".repeat(40),
    version: "1.2.3",
  };
  const before = await collectSourceFiles(source);
  await writeFile(
    path.join(root, "cantrip_codex", "upstream.json"),
    prettyJson(metadata),
  );
  await writeFile(
    path.join(root, "cantrip_codex", "upstream.files.json"),
    prettyJson(sourceManifest(metadata, before)),
  );
  await writeFile(
    path.join(patches, "0001-first.patch"),
    patch("actual source", "first patch"),
  );
  await writeFile(
    path.join(patches, "0002-dependent.patch"),
    patch("first patch", "second patch"),
  );
  return {
    patches,
    run: () =>
      spawnSync(
        process.execPath,
        [path.join(scriptDirectory, "verify-upstream.mjs")],
        {
          cwd: root,
          encoding: "utf8",
          // Even explicit caller repository context must not redirect verification
          // into the real source tree or index.
          env: {
            ...process.env,
            GIT_DIR: path.join(root, ".git"),
            GIT_WORK_TREE: root,
          },
        },
      ),
    unchanged: async () => {
      assert.deepEqual(await collectSourceFiles(source), before);
      assert.deepEqual(await readFile(path.join(root, ".git", "index")), index);
    },
  };
}

test("Codex verifier applies dependent patches in order to actual source without changing source or index", async (t) => {
  const prepared = await fixture(t);
  const result = prepared.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 patches match/);
  await prepared.unchanged();
});

test("Codex verifier names a broken later patch and leaves source and index untouched", async (t) => {
  const prepared = await fixture(t);
  await writeFile(
    path.join(prepared.patches, "0003-broken.patch"),
    patch("missing source", "unreachable change"),
  );
  const result = prepared.run();
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Codex patch 0003-broken\.patch does not apply cleanly/,
  );
  assert.match(result.stderr, /patch failed: source\/sample\.txt/);
  await prepared.unchanged();
});
