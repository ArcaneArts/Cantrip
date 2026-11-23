// Actual Rust worker/server mutations; the owned gh boundary never uses GitHub.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as c from "../../packages/crypto/dist/index.js";
import * as p from "../../packages/protocol/dist/index.js";
import { pullFixture } from "./pull-request-fixture.mjs";
export async function verifyPullRequestActions({
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
  const request = {
    base,
    head: "feature/owned😀",
    title: "Private new PR",
    body: "Private body\ud800",
    labels: ["bug"],
    reviewers: ["reviewer"],
    linkedIssueNumbers: [9, 9],
  };
  const rejected = await operation(
    "github.pull-request.create",
    { request },
    false,
  );
  assert.match(rejected.error, /branch tips must match/);
  assert.deepEqual(await fixture.mutations(), []);
  await fixture.response("remoteRef", { object: { sha } });
  const created = p.githubPullRequestCreateResultSchema.parse(
    (await operation("github.pull-request.create", { request })).result,
  );
  assert.equal(created.pullRequest.number, 43);
  assert.deepEqual(await fixture.mutations(), [
    "createPull",
    "labels",
    "reviewers",
  ]);
  await fixture.response("labels", "", {
    raw: true,
    status: 2,
    stderr: "owned labels failed\n",
  });
  const warned = p.githubPullRequestCreateResultSchema.parse(
    (await operation("github.pull-request.create", { request })).result,
  );
  assert.equal(warned.warnings.length, 1);
  await fixture.reset();
  const action = async (value) =>
    p.githubPullRequestDetailSchema.parse(
      (
        await operation("github.pull-request.review.mutate", {
          number: 43,
          action: value,
        })
      ).result,
    );
  const updated = { ...pullFixture, title: "Private refreshed result" };
  await fixture.after("comment", "pull", updated);
  assert.equal(
    (await action({ type: "comment", body: "Private comment\ud800" })).title,
    updated.title,
  );
  await action({ type: "submit-review", review: { event: "approve" } });
  await action({
    type: "inline-comment",
    comment: {
      body: "Private line",
      path: "src/file.rs",
      line: 5,
      side: "RIGHT",
    },
  });
  await action({ type: "reply", commentId: 101, body: "Private reply" });
  await action({ type: "discard-review" });
  await action({
    type: "set-thread-resolved",
    threadId: "thread-owned",
    resolved: true,
  });
  await action({ type: "set-file-viewed", path: "src/file.rs", viewed: true });
  await action({
    type: "update-details",
    details: {
      title: "Private edit",
      body: "Private edit body",
      labels: ["new"],
      reviewers: ["next"],
    },
  });
  assert.deepEqual(await fixture.mutations(), [
    "comment",
    "submitReview",
    "addThread",
    "reply",
    "deleteReview",
    "resolveThread",
    "markViewed",
    "patchPull",
    "labels",
    "deleteLabel",
    "reviewers",
    "deleteReviewers",
  ]);
  const before = await fixture.mutations();
  const foreign = await operation(
    "github.pull-request.review.mutate",
    {
      number: 43,
      action: {
        type: "set-thread-resolved",
        threadId: "foreign",
        resolved: true,
      },
    },
    false,
  );
  assert.match(foreign.error, /does not belong/);
  assert.deepEqual(await fixture.mutations(), before);
  await restartWorker();
  p.githubPullRequestDetailSchema.parse(
    (await operation("github.pull-request.get", { number: 43 })).result,
  );
  assert.deepEqual(
    await fixture.mutations(),
    before,
    "Restart must not replay completed remote effects",
  );
  p.githubPullRequestDetailSchema.parse(
    (
      await operation("github.pull-request.comment", {
        number: 43,
        body: "Private legacy alias",
      })
    ).result,
  );
  const calls = await fixture.calls();
  assert.ok(
    calls
      .filter((args) => args[1] !== "graphql")
      .every((args) => args[1].startsWith("repos/arcanearts/cantrip/")),
  );
  assert.ok(
    calls.some(
      (args) =>
        args.includes("owner=arcanearts") &&
        args.includes("repository=cantrip"),
    ),
  );
  return {
    encryptedPullRequestActionCommands: commands,
    allEightReviewActions: true,
    publishedBranchGuard: true,
    creationWarnings: true,
    mutationRefresh: true,
    trustedRepositoryAndCheckout: true,
    foreignThreadRejected: true,
    noMutationReplayAfterRestart: true,
  };
}
