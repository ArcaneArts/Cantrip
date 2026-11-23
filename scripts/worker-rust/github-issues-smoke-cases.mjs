// Real protected project operations. No user repository, account or network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as c from "../../packages/crypto/dist/index.js";
import * as p from "../../packages/protocol/dist/index.js";
import { commentFixture } from "./github-issues-fixture.mjs";
export async function verifyGithubIssues({
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
  let commands = 0;
  async function operation(type, arguments_ = {}, ok = true) {
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
          arguments: arguments_,
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
    assert.equal(JSON.stringify(result.body).includes("Private issue"), false);
    assert.equal(JSON.stringify(result.body).includes("Owned issue"), false);
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
  assert.equal(
    (
      await operation(
        "github.issue.get",
        { number: 42, repository: "untrusted/override" },
        false,
      )
    ).error,
    "This checkout does not have a GitHub origin available to the worker.",
  );
  assert.deepEqual(
    await fixture.calls(),
    [],
    "untrusted arguments cannot supply repository authority",
  );
  execFileSync("git", [
    "-C",
    checkout,
    "remote",
    "add",
    "origin",
    "https://github.com/ArcaneArts/Cantrip.git",
  ]);
  const detail = (
    await operation("github.issue.get", {
      number: 42,
      repository: "untrusted/override",
      cwd: "/untrusted",
    })
  ).result;
  assert.equal(detail.number, 42);
  assert.equal(detail.body, "Private issue body\ud800");
  assert.ok(
    (await fixture.calls()).every((args) =>
      args[1].startsWith("repos/arcanearts/cantrip/issues/42"),
    ),
    "checkout origin overrides ciphertext repository arguments",
  );
  const issues = (
    await operation("github.issues.list", { state: "open", limit: 20 })
  ).result;
  assert.equal(issues.issues[0].number, 42);
  const pulls = (
    await operation("github.pull-requests.list", {
      state: "open",
      filters: { mergeability: "mergeable" },
    })
  ).result;
  assert.equal(pulls.pullRequests[0].number, 43);
  assert.equal(pulls.total, null);
  await operation("github.issue.create", {
    request: { title: "  Private create 😀  " },
  });
  await fixture.calls();
  const invalidArgument = await operation(
    "github.issue.create",
    {
      request: {
        title: "Bounded invalid argument",
        body: "x".repeat(140) + "\0",
      },
    },
    false,
  );
  assert.equal(invalidArgument.error.length, 200);
  assert.ok(invalidArgument.error.endsWith("..."));
  assert.deepEqual(
    await fixture.calls(),
    [],
    "invalid argument error is bounded before spawning gh",
  );
  await operation("github.issue.comment", {
    number: 42,
    body: "  Private comment 😀  ",
  });
  await operation("github.issue.close", {
    number: 42,
    comment: "  Private close 😀  ",
  });
  await fixture.calls();
  await operation(
    "github.issues.list",
    { state: "open", filters: { draft: false } },
    false,
  );
  assert.deepEqual(
    await fixture.calls(),
    [],
    "PR-only issue filters fail before gh execution",
  );
  await fixture.response("commentIssue", "", {
    raw: true,
    status: 2,
    stderr: "owned failure before close\n",
  });
  assert.match(
    (
      await operation(
        "github.issue.close",
        { number: 42, comment: "must stop" },
        false,
      )
    ).error,
    /owned failure before close/,
  );
  const failedCalls = await fixture.calls();
  assert.equal(failedCalls.length, 1);
  assert.equal(
    failedCalls[0][1],
    "repos/arcanearts/cantrip/issues/42/comments",
  );
  await fixture.response("comments", "", {
    raw: true,
    status: 3,
    stderr: "owned concurrent read failure\n",
  });
  await fixture.hold("issue");
  try {
    assert.match(
      (await operation("github.issue.get", { number: 42 }, false)).error,
      /owned concurrent read failure/,
    );
    // The sibling gh process is still blocked. Restart must stop and reap it
    // through the owned runtime scope before starting the replacement runtime.
    await restartWorker();
  } finally {
    await fixture.unhold("issue");
    await fixture.response("comments", [[commentFixture]]);
  }
  await operation("github.issue.get", { number: 42 });
  execFileSync("git", ["-C", checkout, "remote", "remove", "origin"]);
  await fixture.calls();
  await operation("github.issue.get", { number: 42 }, false);
  assert.deepEqual(await fixture.calls(), []);
  return {
    encryptedGithubCommands: commands,
    trustedRepositoryRouting: true,
    privateIssueContents: true,
    mutationFailureStopsClose: true,
    originRecheckedAfterRestart: true,
    pendingReadRetiredOnRestart: true,
  };
}
