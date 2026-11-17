// Real Rust worker/server PR inspection over encrypted project operations.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as c from "../../packages/crypto/dist/index.js";
import * as p from "../../packages/protocol/dist/index.js";
export async function verifyPullRequest({
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
  let commands = 0;
  async function query(section, ok = true) {
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
          type: "github.pull-request.get",
          arguments: {
            number: 43,
            section,
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
        access: "read",
        agent: false,
        protectedRequest,
      },
    );
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(
      JSON.stringify(result.body).includes("Private PR body"),
      false,
    );
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
  await fixture.calls();
  const overview = (await query("overview")).result;
  p.githubPullRequestOverviewSchema.parse(overview);
  assert.equal(overview.body, "Private PR body\ud800");
  assert.equal(overview.pendingReview.commentCount, 0);
  assert.equal(overview.autoMerge.method, "squash");
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
  const files = (await query("files")).result;
  p.githubPullRequestFilesSchema.parse(files);
  assert.equal(files.files[0].viewed, true);
  assert.ok(files.files[0].patch.endsWith("\ud800"));
  p.githubPullRequestCommitsSchema.parse((await query("commits")).result);
  p.githubPullRequestChecksSchema.parse((await query("checks")).result);
  const all = p.githubPullRequestDetailSchema.parse(
    (await query("all")).result,
  );
  assert.equal(all.checksState, "success");
  assert.equal(all.reviewThreads[0].comments[0].pending, true);
  await fixture.response("viewed", "", {
    raw: true,
    status: 2,
    stderr: "owned viewed state unavailable\n",
  });
  const partialFiles = (await query("files")).result;
  assert.equal(partialFiles.files[0].viewed, null);
  assert.equal(partialFiles.warnings.length, 1);
  await fixture.response("context", null);
  const fallback = (await query("overview")).result;
  assert.equal(fallback.viewerLogin, null);
  assert.equal(fallback.reviewThreads[0].resolved, null);
  assert.equal(fallback.reviewThreads[0].comments[0].body, "REST thread\ud800");
  for (const name of ["files", "commits", "checks", "statuses"])
    await fixture.response(name, "", {
      raw: true,
      status: 3,
      stderr: "owned section unavailable\n",
    });
  const partial = (await query("all")).result;
  assert.equal(partial.filesTruncated, true);
  assert.equal(partial.checksState, "unknown");
  assert.deepEqual(
    partial.warnings.map((value) => value.section),
    ["review-threads", "files", "commits", "checks"],
  );
  await fixture.reset();
  await fixture.response("files", "", {
    raw: true,
    status: 4,
    stderr: "owned files failed with sibling held\n",
  });
  await fixture.hold("viewed");
  try {
    assert.match((await query("files", false)).error, /owned files failed/);
    await restartWorker();
  } finally {
    await fixture.unhold("viewed");
    await fixture.reset();
  }
  assert.equal((await query("files")).result.files[0].viewed, true);
  return {
    encryptedPullRequestCommands: commands,
    allFiveSections: true,
    trustedRepositoryAndCheckout: true,
    protectedPrivateReviewData: true,
    partialSectionRecovery: true,
    pendingOptionalReadRetiredOnRestart: true,
  };
}
