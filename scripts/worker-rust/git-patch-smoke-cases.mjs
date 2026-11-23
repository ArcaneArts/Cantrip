// Actual encrypted line edits, cross-runtime review tokens and journal guards.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  readGitFileDiff,
  previewGitPartialPatch,
} from "../../tests/reference-node-worker/src/git.ts";
export async function verifyPartialPatches({
  operation,
  checkout,
  restartWorker,
  store,
  scope,
  journal,
}) {
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const file = "native-reviewed-lines.txt",
    absolute = path.join(checkout, file);
  async function request(type, old, new_) {
    const patch = (
      await readGitFileDiff(
        checkout,
        file,
        type === "unstage" ? "staged" : "unstaged",
      )
    ).patch;
    const lines = patch.split("\n"),
      start = lines.findIndex((s) => s.startsWith("@@ "));
    assert.ok(start >= 0);
    const indexes = [old, new_].map((value) => {
      const index = lines.findIndex((line, i) => i > start && line === value);
      assert.ok(index > start, value);
      return index - start - 1;
    });
    return {
      operation: type,
      path: file,
      hunks: [{ hunkIndex: 0, lineIndexes: indexes }],
    };
  }
  async function preview(request) {
    const expected = await previewGitPartialPatch(checkout, request);
    const result = await operation({
      type: "git.patch.preview",
      arguments: { request },
    });
    assert.deepEqual(
      result,
      { ok: true, result: expected },
      "exact Node/native patch and token",
    );
    return expected;
  }
  async function apply(request, plan) {
    const result = await operation({
      type: "git.patch.apply",
      arguments: { request, token: plan.token },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.result;
  }
  git(
    "stash",
    "push",
    "--include-untracked",
    "-m",
    "native patch smoke dirty sentinel",
  );
  const saved = await store.get(scope);
  try {
    const held = await readFile(journal, "utf8");
    await writeFile(absolute, "one\ntwo\nthree\nfour\n");
    git("add", file);
    git("commit", "--quiet", "-m", "Partial patch base");
    await writeFile(absolute, "one\nTWO\nthree\nFOUR\n");
    let selected = await request("stage", "-two", "+TWO"),
      plan = await preview(selected);
    const rejected = await operation({
      type: "git.patch.apply",
      arguments: { request: selected, token: "0".repeat(64) },
    });
    assert.deepEqual(rejected, {
      ok: false,
      error:
        "The working changes no longer match this preview. Review the selection again.",
    });
    assert.equal(git("show", `:${file}`), "one\ntwo\nthree\nfour");
    assert.equal(await readFile(journal, "utf8"), held);
    await restartWorker();
    await apply(selected, plan);
    assert.equal(git("show", `:${file}`), "one\nTWO\nthree\nfour");
    assert.equal(await readFile(absolute, "utf8"), "one\nTWO\nthree\nFOUR\n");
    selected = await request("unstage", "-two", "+TWO");
    plan = await preview(selected);
    await apply(selected, plan);
    assert.equal(git("show", `:${file}`), "one\ntwo\nthree\nfour");
    selected = await request("discard", "-four", "+FOUR");
    await apply(selected, await preview(selected));
    assert.equal(await readFile(absolute, "utf8"), "one\nTWO\nthree\nfour\n");
    assert.equal(
      await readFile(journal, "utf8"),
      held,
      "patch mutations do not replace the managed-operation journal",
    );
    // A persisted active record blocks mutation, while preview remains readable.
    await store.put(scope, {
      ...saved,
      state: "awaiting-user-action",
      completedAt: null,
      error: null,
    });
    const active = await readFile(journal, "utf8");
    selected = await request("stage", "-two", "+TWO");
    plan = await preview(selected);
    assert.deepEqual(
      await operation({
        type: "git.patch.apply",
        arguments: { request: selected, token: plan.token },
      }),
      { ok: false, error: "Finish or abort the active Git operation first." },
    );
    assert.equal(await readFile(journal, "utf8"), active);
    assert.equal(git("show", `:${file}`), "one\ntwo\nthree\nfour");
  } finally {
    await store.put(scope, saved);
    git("stash", "pop");
  }
}
