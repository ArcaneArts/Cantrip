// Actual Rust worker/server mutations; the owned gh boundary never uses GitHub.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as c from "../../packages/crypto/dist/index.js";
import * as p from "../../packages/protocol/dist/index.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pullFixture, checkFixture } from "./pull-request-fixture.mjs";
export async function verifyPullRequestLifecycle({
  call,
  ownerId,
  serverId,
  componentKey,
  projectId,
  workerId,
  checkout,
  fixture,
  restartWorker,
}) {
  const worktrees = await call("GET", `/api/projects/${projectId}/worktrees`);
  assert.equal(worktrees.status, 200);
  const worktreeId = worktrees.body.find(
    (tree) => tree.workerId === workerId && tree.isPrimary,
  )?.id;
  assert.ok(worktreeId);
  execFileSync("git", [
    "-C",
    checkout,
    "remote",
    "add",
    "origin",
    "https://github.com/ArcaneArts/Cantrip.git",
  ]);
  const sha = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const base = execFileSync(
    "git",
    ["-C", checkout, "symbolic-ref", "--short", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  execFileSync("git", ["-C", checkout, "branch", "feature/owned😀"]);
  let commands = 0;
  async function operation(type, args, ok = true) {
    const context = {
      serverId,
      projectId,
      worktreeId,
      operationId: crypto.randomUUID(),
      direction: "request",
    };
    const plaintext = new TextEncoder().encode(
      JSON.stringify(
        p.repositoryOperationRequestContentSchema.parse({
          type,
          arguments: {
            ...args,
            repository: "untrusted/override",
            cwd: "/untrusted",
          },
        }),
      ),
    );
    let protectedRequest;
    try {
      protectedRequest = await c.encryptRepositoryOperationPayload({
        ownerId,
        context,
        keyRevision: 1,
        componentKey,
        plaintext,
      });
    } finally {
      plaintext.fill(0);
    }
    const result = await call(
      "POST",
      `/api/projects/${projectId}/worktrees/${worktreeId}/repository-operation`,
      {
        operationId: context.operationId,
        access: p.repositoryOperationAccess(type),
        agent: false,
        protectedRequest,
      },
    );
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(JSON.stringify(result.body).includes("Private"), false);
    assert.equal(JSON.stringify(result.body).includes(checkout), false);
    const opened = await c.decryptRepositoryOperationPayload({
      ownerId,
      context: { ...context, direction: "response" },
      keyRevision: 1,
      componentKey,
      opaque: result.body.protectedResponse,
    });
    try {
      const outcome = p.repositoryOperationOutcomeContentSchema.parse(
        JSON.parse(new TextDecoder().decode(opened)),
      );
      assert.equal(outcome.ok, ok, JSON.stringify(outcome));
      commands++;
      return outcome;
    } finally {
      opened.fill(0);
    }
  }
  await fixture.reset();
  await fixture.calls();
  const preview = async (action) =>
    p.githubPullRequestLifecyclePreviewSchema.parse(
      (
        await operation("github.pull-request.lifecycle.preview", {
          number: 43,
          action,
        })
      ).result,
    );
  const apply = async (action, reviewed, extra = {}, ok = true) =>
    operation(
      "github.pull-request.lifecycle.apply",
      {
        number: 43,
        request: {
          action,
          token: reviewed.token,
          confirmation: reviewed.confirmationPhrase ?? "",
          ...extra,
        },
      },
      ok,
    );
  const action = { type: "close" },
    reviewed = await preview(action);
  assert.match(
    (await apply(action, reviewed, { token: "0".repeat(64) }, false)).error,
    /no longer matches/,
  );
  assert.match(
    (await apply(action, reviewed, { confirmation: "wrong" }, false)).error,
    /Type close #43/,
  );
  assert.deepEqual(await fixture.mutations(), []);
  await fixture.after("patchPull", "pull", {
    ...pullFixture,
    state: "closed",
    closed_at: "2026-11-17T00:00:00Z",
  });
  assert.equal(
    p.githubPullRequestDetailSchema.parse(
      (await apply(action, reviewed)).result,
    ).state,
    "closed",
  );
  const before = await fixture.mutations();
  await restartWorker();
  assert.equal(
    (await operation("github.pull-request.get", { number: 43 })).result.state,
    "closed",
  );
  assert.deepEqual(await fixture.mutations(), before);
  await fixture.after("patchPull", "pull", pullFixture);
  const reopen = { type: "reopen" };
  assert.equal(
    (await apply(reopen, await preview(reopen))).result.state,
    "open",
  );
  const merge = {
    type: "merge",
    method: "squash",
    commitTitle: "Private merge title",
    commitMessage: "Private merge body\ud800",
  };
  await fixture.after("merge", "pull", {
    ...pullFixture,
    state: "closed",
    merged: true,
  });
  assert.equal((await apply(merge, await preview(merge))).result.merged, true);
  await fixture.reset();
  await fixture.response("checks", {
    total_count: 1,
    check_runs: [{ ...checkFixture, conclusion: "failure" }],
  });
  const context = async (intent) =>
    p.githubPullRequestAgentContextSchema.parse(
      (
        await operation("github.pull-request.agent-context", {
          number: 43,
          request: { intent },
        })
      ).result,
    );
  const evidence = await context("fix-checks");
  assert.match(evidence.failedChecks[0].logExcerpt, /Owned failed step/);
  assert.equal((await context("address-review")).activeReviewThreads.length, 1);
  const bare = path.join(path.dirname(checkout), "owned-pr-source.git");
  execFileSync("git", ["init", "--bare", "--quiet", bare]);
  const tree = execFileSync(
    "git",
    ["-C", checkout, "rev-parse", "HEAD^{tree}"],
    { encoding: "utf8" },
  ).trim();
  const fetchedSha = execFileSync(
    "git",
    [
      "-C",
      checkout,
      "-c",
      "user.name=Owned",
      "-c",
      "user.email=owned@example.invalid",
      "commit-tree",
      tree,
      "-p",
      sha,
      "-m",
      "Owned PR source",
    ],
    { encoding: "utf8" },
  ).trim();
  execFileSync("git", [
    "-C",
    checkout,
    "push",
    "--quiet",
    bare,
    fetchedSha + ":refs/pull/43/head",
  ]);
  await fixture.bindFetch(bare);
  await fixture.response("pull", {
    ...pullFixture,
    head: { ref: "feature/é😀", sha: fetchedSha },
  });
  const prepared = p.githubPullRequestCheckoutPreparedSchema.parse(
    (await operation("github.pull-request.checkout.prepare", { number: 43 }))
      .result,
  );
  assert.equal(prepared.headSha, fetchedSha);
  assert.equal(prepared.remote, "origin");
  assert.equal(
    execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    sha,
  );
  assert.equal(
    execFileSync("git", ["-C", checkout, "symbolic-ref", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    base,
  );
  assert.equal(
    await readFile(path.join(checkout, "untouched.txt"), "utf8"),
    "private dirty content\n",
  );
  await fixture.response("pull", pullFixture);
  assert.match(
    (
      await operation(
        "github.pull-request.checkout.prepare",
        { number: 43 },
        false,
      )
    ).error,
    /changed while its checkout/,
  );
  const calls = await fixture.calls();
  assert.ok(
    calls
      .filter((args) => args[0] === "api" && args[1] !== "graphql")
      .every((args) => args[1].startsWith("repos/arcanearts/cantrip/")),
  );
  assert.ok(
    calls.some(
      (args) =>
        args[0] === "run" &&
        args[3] === "--repo" &&
        args[4] === "arcanearts/cantrip",
    ),
  );
  return {
    encryptedLifecycleCommands: commands,
    staleAndConfirmationGuards: true,
    refreshedCloseReopenMerge: true,
    noEffectsReplayedOnRestart: true,
    agentReviewAndFailedCheckEvidence: true,
    exactCommitFetchWithoutWorktreeChange: true,
    trustedRepositoryAndCheckout: true,
  };
}
