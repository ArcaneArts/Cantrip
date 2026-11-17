// Actual Rust worker/server mutations; the owned gh boundary never uses GitHub.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as c from "../../packages/crypto/dist/index.js";
import * as p from "../../packages/protocol/dist/index.js";
import {
  workflowFixture,
  runFixture,
  noticeFixture,
} from "./github-operations-fixture.mjs";
export async function verifyGithubOperations({
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
  const inbox = p.githubInboxListSchema.parse(
    (
      await operation("github.inbox.list", {
        kind: "pull-request",
        state: "open",
        view: "all",
      })
    ).result,
  );
  assert.ok(inbox.items[0].attention.includes("mention"));
  await fixture.response("notifications", "", {
    raw: true,
    status: 2,
    stderr: "owned notifications unavailable\n",
  });
  const fallback = p.githubInboxListSchema.parse(
    (
      await operation("github.inbox.list", {
        kind: "pull-request",
        state: "open",
        view: "activity",
      })
    ).result,
  );
  assert.equal(fallback.activityAvailable, false);
  assert.ok(fallback.items[0].attention.includes("mention"));
  await fixture.response("notifications", [noticeFixture]);
  const overview = p.githubActionsOverviewSchema.parse(
    (await operation("github.actions.overview", {})).result,
  );
  assert.equal(overview.runs[0].displayTitle, "Private workflow run 😀");
  await fixture.response("runners", "", {
    raw: true,
    status: 2,
    stderr: "owned admin restriction\n",
  });
  assert.equal(
    (await operation("github.actions.overview", {})).result.runnerAccess,
    "unavailable",
  );
  await fixture.reset();
  const detail = p.githubActionsRunDetailSchema.parse(
    (await operation("github.actions.run.get", { runId: 7 })).result,
  );
  assert.equal(detail.artifacts[0].testReport, true);
  await fixture.response("jobs", "", {
    raw: true,
    status: 2,
    stderr: "owned jobs unavailable\n",
  });
  const partial = (await operation("github.actions.run.get", { runId: 7 }))
    .result;
  assert.equal(partial.jobs.length, 0);
  assert.equal(partial.artifacts.length, 1);
  assert.equal(partial.warnings.length, 1);
  const logs = p.githubActionsRunLogsSchema.parse(
    (await operation("github.actions.run.logs", { runId: 7, jobId: 17 }))
      .result,
  );
  assert.ok(logs.text.startsWith("Private failed output"));
  assert.equal(logs.text.includes("\u001b"), false);
  await operation("github.actions.workflow.dispatch", {
    request: { workflowId: 9, ref: "main", inputs: { z: "last", a: "first" } },
  });
  for (const action of ["cancel", "rerun", "rerun-failed"])
    p.githubActionsMutationResultSchema.parse(
      (
        await operation("github.actions.run.action", {
          request: { runId: 7, action },
        })
      ).result,
    );
  assert.deepEqual(await fixture.mutations(), [
    "dispatch",
    "cancel",
    "rerun",
    "rerunFailed",
  ]);
  await fixture.response("run", { ...runFixture, head_sha: sha });
  const prepared = p.githubActionsRunCheckoutPreparedSchema.parse(
    (await operation("github.actions.run.checkout.prepare", { runId: 7 }))
      .result,
  );
  assert.equal(prepared.headSha, sha);
  assert.equal(prepared.remote, "origin");
  p.githubReleaseListSchema.parse(
    (await operation("github.releases.list", {})).result,
  );
  const release = p.githubReleaseSummarySchema.parse(
    (await operation("github.release.get", { releaseId: 37 })).result,
  );
  assert.ok(release.body.endsWith("\ud800"));
  p.githubReleaseSummarySchema.parse(
    (
      await operation("github.release.create", {
        request: {
          tagName: "v-owned",
          name: "Private release",
          body: "Private body\ud800",
          draft: true,
          prerelease: false,
        },
      })
    ).result,
  );
  const mutations = await fixture.mutations();
  assert.equal(mutations.at(-1), "createRelease");
  await fixture.response("workflows", "", {
    raw: true,
    status: 2,
    stderr: "owned workflows failed while run read held\n",
  });
  await fixture.hold("runs");
  try {
    assert.match(
      (await operation("github.actions.overview", {}, false)).error,
      /owned workflows failed/,
    );
    await restartWorker();
  } finally {
    await fixture.unhold("runs");
    await fixture.response("workflows", {
      total_count: 1,
      workflows: [workflowFixture],
    });
  }
  assert.equal(
    (await operation("github.actions.overview", {})).result.runnerAccess,
    "available",
  );
  assert.deepEqual(
    await fixture.mutations(),
    mutations,
    "Restart does not replay accepted remote mutations",
  );
  const calls = await fixture.calls();
  assert.ok(
    calls
      .filter(
        (args) =>
          args[0] === "api" && args[1] !== "graphql" && args[1] !== "user",
      )
      .every((args) => args[1].startsWith("repos/arcanearts/cantrip/")),
  );
  assert.ok(
    calls.some((args) => args[0] === "run" && args[4] === "arcanearts/cantrip"),
  );
  return {
    encryptedGithubOperationCommands: commands,
    allTenCommandKinds: true,
    trustedRepositoryAndCheckout: true,
    notificationFallback: true,
    runnerAccessAndPartialRunDetails: true,
    capturedProtectedLogs: true,
    voidMutationResults: true,
    releaseAndCheckout: true,
    heldConcurrentReadRetiredOnRestart: true,
  };
}
