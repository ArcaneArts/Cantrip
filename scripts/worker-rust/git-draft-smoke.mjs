import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { taskModelProvider } from "../server-rust/task-model-provider.mjs";

export async function verifyGitDrafts({
  call,
  checkout,
  git,
  operation,
  projectId,
  workerId,
}) {
  const worktrees = await call("GET", `/api/projects/${projectId}/worktrees`);
  assert.equal(worktrees.status, 200, JSON.stringify(worktrees));
  const worktree = worktrees.body.find(
    (tree) => tree.workerId === workerId && tree.isPrimary,
  );
  assert.ok(worktree, JSON.stringify(worktrees));
  const run = (...args) =>
    execFileSync(git, ["-C", checkout, ...args], { encoding: "utf8" });
  await writeFile(
    path.join(checkout, "staged.txt"),
    "private staged evidence\n",
  );
  run("add", "staged.txt");
  const before = run("status", "--porcelain=v1");
  const head = run("rev-parse", "HEAD");
  const upstream = await taskModelProvider();
  try {
    const providers = [];
    for (const name of ["First fixture route", "Second fixture route"]) {
      const provider = await call("POST", "/api/settings/providers", {
        id: randomUUID(),
        kind: "openai-compatible",
        name,
        baseUrl: upstream.baseUrl,
        initialAccount: null,
        protectedApiKey: null,
        maxConcurrentInference: 1,
      });
      assert.equal(provider.status, 201, JSON.stringify(provider));
      providers.push(provider.body);
    }
    const profile = await call("POST", "/api/settings/models", {
      name: "Fixture Git draft",
      routes: providers.map((provider) => ({
        providerId: provider.id,
        modelName: upstream.model,
        enabled: true,
      })),
    });
    assert.equal(profile.status, 201, JSON.stringify(profile));
    const model = profile.body;
    const draft = (arguments_) =>
      operation(
        projectId,
        { type: "git.agent.generate", arguments: arguments_ },
        `/api/projects/${projectId}/worktrees/${worktree.id}/repository-operation`,
        { access: "read", agent: true, modelId: model.id },
        worktree.id,
      );
    const invalid = await draft({
      task: "review-commit-range",
      baseRevision: "HEAD",
    });
    assert.equal(invalid.outcome.ok, false, JSON.stringify(invalid));
    assert.match(invalid.outcome.error, /requires both base and head/u);
    const unsafe = await draft({
      task: "review-commit-range",
      baseRevision: "--output=unapproved",
      headRevision: "HEAD",
    });
    assert.equal(unsafe.outcome.ok, false, JSON.stringify(unsafe));
    assert.match(unsafe.outcome.error, /Expected a safe Git revision/u);
    assert.equal(
      upstream.requests.filter((entry) => entry.method === "POST").length,
      0,
    );

    const rejected = upstream.reply({ text: "{}" });
    const expected = "Describe the staged evidence";
    const accepted = upstream.reply({
      text: JSON.stringify({ text: expected }),
    });
    const result = await draft({
      task: "draft-commit-message",
      modelId: model.id,
      instructions: "Use one short subject.",
    });
    assert.equal(result.outcome.ok, true, JSON.stringify(result));
    assert.equal(result.outcome.result.text, expected);
    assert.equal(result.outcome.result.providerName, providers[1].name);
    assert.equal(result.outcome.result.modelName, upstream.model);
    assert.equal(result.outcome.result.modelId, model.id);
    assert.equal(result.outcome.result.worktreeId, worktree.id);
    assert.equal(result.outcome.result.generationId, result.body.operationId);
    const selected = model.routes.find(
      (route) => route.providerId === providers[1].id,
    );
    assert.equal(result.body.agentExecution.routeId, selected.id);
    assert.equal(result.body.agentExecution.measuredUsage.totalTokens, 120);
    assert.ok(result.body.agentExecution.turnId);
    assert.equal(JSON.stringify(result.body).includes(expected), false);
    const telemetry = await call(
      "GET",
      `/api/analytics/provider-telemetry/${providers[1].id}/export`,
    );
    assert.equal(telemetry.status, 200, JSON.stringify(telemetry));
    const usage = telemetry.body.tokenUsage.find(
      (row) =>
        row.executionAttemptId === `${result.body.operationId}:${selected.id}`,
    );
    assert.ok(usage, JSON.stringify(telemetry));
    assert.equal(usage.turnId, result.body.agentExecution.turnId);
    for (const attempt of [rejected, accepted]) {
      assert.ok(attempt.entered);
      const { input, text } = attempt.request.input;
      const evidence = JSON.stringify(input);
      assert.match(evidence, /Staged patch/u);
      assert.match(evidence, /private staged evidence/u);
      assert.match(evidence, /Use one short subject/u);
      assert.match(evidence, /untrusted evidence/u);
      assert.equal(text.format.type, "json_schema");
      assert.deepEqual(text.format.schema.required, ["text"]);
    }
    assert.equal(run("rev-parse", "HEAD"), head);
    assert.equal(run("status", "--porcelain=v1"), before);
    assert.deepEqual(upstream.failures, []);
  } finally {
    await upstream.close();
  }
}
