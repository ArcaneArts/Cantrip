// Existing browser SDK/cryptography -> real server -> unchanged complete worker.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { repositoryRoot } from "./build.mjs";

export async function actualProjectInsights({
  page,
  projectId,
  workerId,
  directory,
  result,
  phase,
}) {
  const script = "private-insight-proof";
  const brief = "Private retained insight Task brief 🌿";
  if (phase === "connected")
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: "insight-fixture",
        version: "1.0.0",
        scripts: { [script]: "printf private-script-content" },
      }),
    );
  const responses = [];
  const capture = (response) => {
    const url = new URL(response.url());
    if (
      /\/(?:repository-stats|token-usage|script-commands|tasks\/workload)$/u.test(
        url.pathname,
      )
    )
      responses.push(
        response.text().then((body) => ({
          pathname: url.pathname,
          status: response.status(),
          body,
        })),
      );
  };
  page.on("response", capture);
  try {
    const value = await page.evaluate(
      async ({ projectId, workerId, brief, phase, protocolUrl }) => {
        const terminals = await import("/src/lib/api/terminals.ts");
        const tasks = await import("/src/lib/api/tasks.ts");
        const workers = await import("/src/lib/api/worker-wire.ts");
        const worker = (await workers.getWorkers()).find(
          (w) => w.workerId === workerId,
        );
        await (
          await import("/src/lib/surface-private-state-worker-encryption.ts")
        ).ensureSurfacePrivateStateWorkerEncryption({ worker });
        if (phase === "connected") {
          const terminal = await terminals.createTerminal(
            projectId,
            "Private insight terminal",
          );
          const created = await tasks.createTask(
            projectId,
            "Private insight Task",
          );
          await tasks.updateTaskDraft(created.chat.id, {
            rowVersion: created.task.rowVersion,
            briefMarkdown: brief,
          });
          window.insightAcceptance = {
            terminalId: terminal.id,
            chatId: created.chat.id,
          };
        }
        const retained = window.insightAcceptance;
        const stats = await (
          await import("/src/lib/api/git.ts")
        ).getProjectRepositoryStats(projectId);
        const usage = await (
          await import("/src/lib/api/telemetry.ts")
        ).getProjectTokenUsage(projectId);
        const projectCommands =
          await terminals.getProjectScriptCommands(projectId);
        const terminalCommands = await terminals.getTerminalScriptCommands(
          retained.terminalId,
          workerId,
        );
        const workload = await tasks.getProjectTaskWorkload(projectId);
        // Exercise the real endpoint AAD with the worker's actual encrypted bytes.
        const operationId = crypto.randomUUID();
        const wire = await (
          await import("/src/lib/api-client.ts")
        ).request(
          `/api/projects/${encodeURIComponent(projectId)}/script-commands?operationId=${operationId}`,
        );
        const { openRepositoryOperationContent } =
          await import("/src/lib/repository-operation-encryption.ts");
        const { scriptCommandListSchema } = await import(protocolUrl);
        let wrongBindingRejected = false;
        try {
          await openRepositoryOperationContent({
            context: {
              projectId: wire.projectId,
              worktreeId: "wrong-worktree",
              operationId,
              direction: "response",
            },
            opaque: wire.protectedCommands,
            schema: scriptCommandListSchema,
          });
        } catch {
          wrongBindingRejected = true;
        }
        const verified = await openRepositoryOperationContent({
          context: {
            projectId: wire.projectId,
            worktreeId: wire.worktreeId,
            operationId,
            direction: "response",
          },
          opaque: wire.protectedCommands,
          schema: scriptCommandListSchema,
        });
        return {
          retained,
          stats,
          usage,
          projectCommands,
          terminalCommands,
          workload,
          wrongBindingRejected,
          verified,
        };
      },
      {
        projectId,
        workerId,
        brief,
        phase,
        protocolUrl: `/@fs${repositoryRoot}/packages/protocol/src/index.ts`,
      },
    );
    assert.equal(value.stats.kind, "folder");
    assert.ok(value.stats.fileCount >= 1);
    assert.equal(value.usage.total.totalTokens, 0);
    for (const commands of [
      value.projectCommands,
      value.terminalCommands,
      value.verified,
    ])
      assert.ok(
        commands.some((command) => command.command.includes(script)),
        JSON.stringify(commands),
      );
    const task = value.workload.items.find(
      (item) => item.task.chatId === value.retained.chatId,
    );
    assert.ok(task);
    assert.equal(task.task.briefMarkdown, brief);
    assert.equal(value.wrongBindingRejected, true);
    const wire = await Promise.all(responses);
    assert.ok(wire.length >= 6);
    for (const response of wire) {
      assert.equal(response.status, 200);
      for (const secret of [script, brief, "private-script-content"])
        assert.equal(
          response.body.includes(secret),
          false,
          "server HTTP responses retain endpoint opacity",
        );
    }
    (result.projectInsights ??= []).push({ phase, ...value, wire });
    result.steps.push(
      phase +
        ": existing browser reads real folder statistics and usage, decrypts project/terminal script commands and retained Task workload, and rejects a changed worktree binding",
    );
  } finally {
    page.off("response", capture);
  }
}
