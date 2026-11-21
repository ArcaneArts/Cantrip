import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  gitActionResultSchema,
  gitForcePushPreviewSchema,
} from "../../packages/protocol/dist/index.js";
import { handleGitCommand } from "../../tests/reference-node-worker/src/commands/git.ts";

export async function verifyForcePush(checkout, operation) {
  const root = path.dirname(path.dirname(checkout));
  const bare = path.join(root, "force-push-remote.git");
  const peer = path.join(root, "force-push-peer");
  const hooks = path.join(root, "force-push-hooks");
  const remote = "team/review";
  const branch = "publish/résumé";
  const remoteRef = `refs/heads/${branch}`;
  const localBranch = "local/révision";
  const localRef = `refs/heads/${localBranch}`;
  const git = (cwd, ...args) =>
    execFileSync(
      "git",
      [
        "-C",
        cwd,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  const preview = () =>
    operation({
      type: "git.force-push.preview",
      arguments: { cwd: "/not-the-routed-checkout" },
    });
  const apply = (token) =>
    operation({ type: "git.force-push.apply", arguments: { token } });
  const tip = () => git(bare, "rev-parse", remoteRef);
  function failure(result, expected) {
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.error, expected);
  }
  async function comparePreview() {
    const result = await preview();
    assert.equal(result.ok, true, JSON.stringify(result));
    const actual = gitForcePushPreviewSchema.parse(result.result);
    const archived = await handleGitCommand({
      type: "git.force-push.preview",
      cwd: checkout,
    });
    assert.deepEqual(actual, archived);
    return actual;
  }
  function advancePeer(subject) {
    git(peer, "commit", "--allow-empty", "-m", subject);
    return git(peer, "rev-parse", "HEAD");
  }
  async function prePush(script) {
    await writeFile(
      path.join(hooks, "pre-push"),
      `#!/bin/sh\nset -eu\n${script}\n`,
      {
        mode: 0o755,
      },
    );
  }

  const base = git(checkout, "rev-parse", "HEAD");
  git(checkout, "switch", "--detach", base);
  failure(await preview(), /Cannot force-push a detached HEAD/u);
  git(checkout, "switch", "-c", localBranch);
  failure(await preview(), /This branch has no upstream/u);
  git(root, "init", "--bare", bare);
  git(checkout, "remote", "add", remote, bare);
  git(checkout, "push", "-u", remote, `HEAD:${remoteRef}`);
  git(checkout, "push", remote, "HEAD:refs/heads/untouched");
  failure(await preview(), /Use a normal push/u);

  git(root, "clone", "--branch", branch, bare, peer);
  const remoteHead = advancePeer("Published commit");
  git(peer, "push", "origin", `HEAD:${remoteRef}`);
  failure(await preview(), /only behind its remote/u);

  git(checkout, "commit", "--allow-empty", "-m", "Reviewed local commit");
  const reviewed = await comparePreview();
  assert.equal(reviewed.expectedRemoteHead, remoteHead);
  assert.equal(reviewed.localCommitCount, 1);
  assert.equal(reviewed.remoteCommitCount, 1);
  assert.equal(reviewed.localBranch, localBranch);
  assert.equal(reviewed.remoteBranch, branch);
  assert.equal(tip(), remoteHead);

  git(checkout, "commit", "--allow-empty", "-m", "Unreviewed local commit");
  const movedLocal = git(checkout, "rev-parse", "HEAD");
  const moved = /local or remote branch moved after this preview/u;
  failure(await apply(reviewed.token), moved);
  assert.equal(tip(), remoteHead);
  git(checkout, "reset", "--soft", reviewed.localHead);
  const advanced = advancePeer("Remote moved after preview");
  git(peer, "push", "origin", `HEAD:${remoteRef}`);
  failure(await apply(reviewed.token), moved);
  assert.equal(tip(), advanced);

  const beforeRace = await comparePreview();
  const duringPush = advancePeer("Remote moved during push");
  git(peer, "push", "origin", "HEAD:refs/heads/race-keeper");
  await mkdir(hooks);
  git(checkout, "config", "core.hooksPath", hooks);
  // The remote has already advertised its old tip when this hook runs.
  await prePush(
    `git -C "$2" update-ref '${remoteRef}' ${duringPush} ${advanced}`,
  );
  failure(await apply(beforeRace.token), /cannot lock ref|stale info/u);
  assert.equal(tip(), duringPush);

  const final = await comparePreview();
  git(checkout, "remote", "add", `${remote}/publish`, bare);
  const overlappingRemote = await preview();
  assert.equal(overlappingRemote.ok, true, JSON.stringify(overlappingRemote));
  assert.deepEqual(overlappingRemote.result, final);
  git(checkout, "tag", "-am", "Unreviewed tag", "fixture-tag", final.localHead);
  git(checkout, "config", "push.followTags", "true");
  await prePush(`read -r source object ref previous
test "$source" = '${final.localHead}'
test "$object" = '${final.localHead}'
test "$ref" = '${remoteRef}'
test "$previous" = '${duringPush}'
git update-ref '${localRef}' ${movedLocal} ${final.localHead}`);
  const result = await apply(final.token);
  assert.equal(result.ok, true, JSON.stringify(result));
  const applied = gitActionResultSchema.parse(result.result);
  assert.match(applied.output, /forced update/u);
  assert.equal(applied.status.head, movedLocal);
  assert.equal(git(checkout, "rev-parse", "HEAD"), movedLocal);
  assert.equal(tip(), final.localHead);
  assert.equal(git(bare, "rev-parse", "refs/heads/untouched"), base);
  assert.equal(git(bare, "rev-parse", "refs/heads/race-keeper"), duringPush);
  assert.equal(git(bare, "tag", "--list"), "");
}
