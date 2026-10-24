import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, unlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { auditRunConfigurationCutover } from "./audit-run-configuration-cutover.mjs";

test("audits current tracked and new source while ignoring deleted and ignored files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-cutover-audit-"));
  const legacy = ["run", "start"].join("_");
  try {
    execFileSync("git", ["init", "-q", root]);
    await mkdir(path.join(root, "scripts"));
    await writeFile(path.join(root, "scripts/removed.js"), legacy);
    execFileSync("git", ["add", "scripts/removed.js"], { cwd: root });
    await unlink(path.join(root, "scripts/removed.js"));
    assert.deepEqual(await auditRunConfigurationCutover(root), []);
    await writeFile(path.join(root, "scripts/new.js"), legacy);
    assert.deepEqual(
      (await auditRunConfigurationCutover(root)).map(
        ({ relativePath }) => relativePath,
      ),
      ["scripts/new.js"],
    );
    execFileSync("git", ["add", "scripts/new.js"], { cwd: root });
    assert.equal((await auditRunConfigurationCutover(root)).length, 1);
    await writeFile(path.join(root, "scripts/new.js"), "replacement contract");
    await writeFile(path.join(root, ".gitignore"), "scripts/ignored.js\n");
    await writeFile(path.join(root, "scripts/ignored.js"), legacy);
    assert.deepEqual(await auditRunConfigurationCutover(root), []);
    await mkdir(path.join(root, "scripts/unreadable.js"));
    // A tracked path that became a directory must not be silently skipped.
    execFileSync(
      "git",
      [
        "update-index",
        "--add",
        "--cacheinfo",
        "100644",
        execFileSync("git", ["hash-object", "-w", "scripts/new.js"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        "scripts/unreadable.js",
      ],
      { cwd: root },
    );
    await assert.rejects(auditRunConfigurationCutover(root), {
      code: "EISDIR",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
