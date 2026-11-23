import { nodeGit } from "./git-node-reference.mjs";
// Actual encrypted tag actions, immutable signatures and journal ownership.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readGitTags,
  readGitTagDetail,
  readGitStatus,
} from "../../tests/reference-node-worker/src/git.ts";
function normalize(value, key) {
  if (key === "generatedAt") {
    assert.ok(Number.isFinite(Date.parse(value)));
    return "<timestamp>";
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, value]) => [key, normalize(value, key)]),
    );
  return value;
}
export async function verifyTags({
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
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-native-tags-")),
    remote = path.join(root, "remote.git"),
    remoteName = "native-reviewed-tags",
    light = "native-reviewed-light",
    annotated = "native-reviewed-annotated",
    signed = "native-reviewed-signed",
    key = path.join(root, "signing-key"),
    signers = path.join(root, "allowed-signers"),
    saved = await store.get(scope),
    before = await readFile(journal, "utf8");
  const config = [
    "gpg.format",
    "user.signingKey",
    "gpg.ssh.allowedSignersFile",
    "gpg.ssh.program",
    "tag.gpgSign",
  ].map((key) => {
    try {
      return [key, git("config", "--get", key)];
    } catch {
      return [key, null];
    }
  });
  async function list() {
    const result = await operation({ type: "git.tag.list", arguments: {} });
    assert.deepEqual(
      normalize(result),
      normalize({ ok: true, result: await readGitTags(checkout) }),
    );
    return result.result;
  }
  async function detail(name) {
    const result = await operation({
      type: "git.tag.get",
      arguments: { name },
    });
    assert.deepEqual(result, {
      ok: true,
      result: await readGitTagDetail(checkout, name),
    });
    return result.result;
  }
  async function preview(action) {
    const expected = await nodeGit(checkout, "git.tag.action.preview", {
      action,
    });
    const result = await operation({
      type: "git.tag.action.preview",
      arguments: { action },
    });
    assert.deepEqual(
      result,
      { ok: true, result: expected },
      "exact Node/native tag review and token",
    );
    return expected;
  }
  async function apply(plan) {
    const result = await operation({
      type: "git.tag.action.apply",
      arguments: { action: plan.action, token: plan.token },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(
      normalize(result.result.tags),
      normalize(await readGitTags(checkout)),
    );
    assert.deepEqual(result.result.status, await readGitStatus(checkout));
    return result.result;
  }
  const create = (name, annotated = false, message = null) => ({
    type: "create",
    name,
    target: null,
    annotated,
    message,
  });
  try {
    git("config", "tag.gpgSign", "false");
    git("clone", "--quiet", "--bare", checkout, remote);
    git("remote", "add", remoteName, remote);
    let plan = await preview(create(light));
    assert.deepEqual(
      await operation({
        type: "git.tag.action.apply",
        arguments: { action: plan.action, token: "0".repeat(64) },
      }),
      {
        ok: false,
        error:
          "The tags, remotes, or worktree changed after this preview. Review the action again.",
      },
    );
    await restartWorker();
    await apply(plan);
    assert.equal((await detail(light)).annotated, false);
    await apply(
      await preview(create(annotated, true, "Native notes 🧙\n\nBody text")),
    );
    assert.ok((await detail(annotated)).message.includes("Body text"));
    await apply(
      await preview({ type: "push", name: annotated, remote: remoteName }),
    );
    assert.equal(
      git("--git-dir", remote, "rev-parse", `refs/tags/${annotated}`),
      git("rev-parse", `refs/tags/${annotated}`),
    );
    assert.equal(
      (await preview({ type: "deleteLocal", name: annotated })).warnings.length,
      1,
    );
    plan = await preview(create("native-stale-tag"));
    git("tag", "native-changed-tag");
    assert.deepEqual(
      await operation({
        type: "git.tag.action.apply",
        arguments: { action: plan.action, token: plan.token },
      }),
      {
        ok: false,
        error:
          "The tags, remotes, or worktree changed after this preview. Review the action again.",
      },
    );
    git("tag", "-d", "native-changed-tag");
    await apply(
      await preview({
        type: "deleteRemote",
        name: annotated,
        remote: remoteName,
      }),
    );
    assert.throws(() =>
      git(
        "--git-dir",
        remote,
        "rev-parse",
        "--verify",
        `refs/tags/${annotated}`,
      ),
    );
    await apply(await preview({ type: "deleteLocal", name: annotated }));
    const verifier = execFileSync("/usr/bin/which", ["ssh-keygen"], {
      encoding: "utf8",
    }).trim();
    execFileSync(verifier, ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    const publicKey = (await readFile(`${key}.pub`, "utf8")).trim();
    await writeFile(signers, `fixture@example.invalid ${publicKey}\n`);
    for (const [k, v] of Object.entries({
      "gpg.format": "ssh",
      "user.signingKey": key,
      "gpg.ssh.allowedSignersFile": signers,
      "gpg.ssh.program": verifier,
      "tag.gpgSign": "true",
    }))
      git("config", k, v);
    await apply(await preview(create(signed, true, "Signed native fixture")));
    assert.equal((await detail(signed)).signature.status, "valid");
    await restartWorker();
    assert.equal(
      (await list()).tags.find((t) => t.name === signed).signature.status,
      "valid",
    );
    await writeFile(signers, "");
    assert.equal((await detail(signed)).signature.status, "valid-unknown");
    await writeFile(signers, `fixture@example.invalid ${publicKey}\n`);
    await apply(await preview({ type: "deleteLocal", name: signed }));
    await apply(await preview({ type: "deleteLocal", name: light }));
    assert.equal(
      await readFile(journal, "utf8"),
      before,
      "tag mutations preserve the managed-operation journal",
    );
    await store.put(scope, {
      ...saved,
      state: "awaiting-user-action",
      completedAt: null,
      error: null,
    });
    const active = await readFile(journal, "utf8");
    plan = await preview(create(light));
    assert.deepEqual(
      await operation({
        type: "git.tag.action.apply",
        arguments: { action: plan.action, token: plan.token },
      }),
      { ok: false, error: "Finish or abort the active Git operation first." },
    );
    assert.ok(!(await list()).tags.some((t) => t.name === light));
    assert.equal(await readFile(journal, "utf8"), active);
  } finally {
    await store.put(scope, saved);
    for (const name of [light, annotated, signed, "native-changed-tag"])
      if (git("tag", "--list", name)) git("tag", "-d", name);
    if (git("remote").split("\n").includes(remoteName))
      git("remote", "remove", remoteName);
    for (const [key, value] of config) {
      if (value !== null) git("config", key, value);
      else {
        try {
          git("config", "--unset", key);
        } catch {
          /* Already absent. */
        }
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}
