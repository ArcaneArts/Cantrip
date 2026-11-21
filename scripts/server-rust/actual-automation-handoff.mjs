import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { automationDispatchWorkerEnvironment } from "./actual-automation-dispatch-interruption.mjs";
import { eventually, launchActualWorker } from "./full-worker.mjs";
import { normalizeProjectSourcePath } from "../../tests/reference-node-worker/src/project-source-path.ts";

export function actualAutomationHandoff({
  chatId,
  cliBinary,
  fixture,
  page,
  projectId,
  projectRoot,
  workerDataDirectory,
  workerId,
}) {
  const targetWorkerId = "actual-automation-target";
  const dataDirectory = workerDataDirectory + "-automation-target";
  const probe = path.join(dataDirectory, "test-automation-dispatch");
  let worker, target;
  return {
    workerId: targetWorkerId,
    probe,
    async prepare() {
      const clone = dataDirectory + "-checkout";
      execFileSync("git", [
        "clone",
        "--no-hardlinks",
        "--",
        projectRoot,
        clone,
      ]);
      const revision = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const placementPath = normalizeProjectSourcePath(await realpath(clone));
      const enrollment = await page.evaluate(
        async (workerId) =>
          (await import("/src/lib/api/workers.ts")).createWorkerEnrollmentCode({
            label: workerId,
          }),
        targetWorkerId,
      );
      worker = launchActualWorker(fixture.workerFixture, dataDirectory, {
        cliBinary,
        enrollmentCode: enrollment.code,
        workerId: targetWorkerId,
        environment: automationDispatchWorkerEnvironment(probe),
      });
      await worker.ready();
      await fixture.assertRemoteWorker(targetWorkerId);
      await page.evaluate(
        async ({ source, target }) => {
          const workers = await window.folderWorkers.getWorkers();
          const { ensureChatWorkerEncryption } =
            await import("/src/lib/chat-worker-encryption.ts");
          for (const id of [source, target]) {
            const worker = workers.find((entry) => entry.workerId === id);
            if (!worker?.online)
              throw new Error("Placement worker is offline: " + id);
            await ensureChatWorkerEncryption({ worker });
          }
        },
        { source: workerId, target: targetWorkerId },
      );
      const replicaJob = await page.evaluate(
        async ({ projectId, targetWorkerId, placementPath, revision }) =>
          window.folderApi.createProjectReplica(projectId, {
            workerId: targetWorkerId,
            placement: { mode: "direct", path: placementPath },
            expectedRevision: revision,
            idempotencyKey: crypto.randomUUID(),
          }),
        { projectId, targetWorkerId, placementPath, revision },
      );
      await eventually(
        () =>
          page.evaluate(
            (id) => window.folderApi.getProjectReplicaJob(id),
            replicaJob.id,
          ),
        (job) => assert.equal(job.state, "succeeded", JSON.stringify(job)),
      );
      const worktrees = await page.evaluate(
        (id) => window.folderWire.getProjectWorktreeWireList(id),
        projectId,
      );
      target = worktrees.find(
        (entry) => entry.workerId === targetWorkerId && entry.isPrimary,
      );
      assert.equal(target?.lifecycleState, "ready");
      assert.equal(target.head, revision);
    },
    async move(id) {
      await fixture.assertRemoteWorker(targetWorkerId);
      const before = await page.evaluate(
        async ({ projectId, chatId }) => {
          const chats = await (
            await import("/src/lib/api/chats.ts")
          ).getChats(projectId);
          const chat = chats.find(({ id }) => id === chatId);
          const worktrees =
            await window.folderWire.getProjectWorktreeWireList(projectId);
          const source = worktrees.find(
            ({ id }) => id === chat.activeWorktreeId,
          );
          return {
            id: source.id,
            workerId: source.workerId,
            head: source.head,
          };
        },
        { projectId, chatId },
      );
      assert.equal(before.workerId, workerId);
      assert.equal(
        before.head,
        null,
        "direct import leaves the initial revision unobserved",
      );
      await writeFile(
        probe + ".armed",
        JSON.stringify({ id, phase: "observe" }),
      );
      const admitted = await page.evaluate(
        async ({ chatId, projectId, worktreeId }) =>
          (await import("/src/lib/api/imports.ts")).createChatRelocation(
            chatId,
            {
              approved: true,
              idempotencyKey: crypto.randomUUID(),
              target: { kind: "worktree", projectId, worktreeId },
            },
          ),
        { chatId, projectId, worktreeId: target.id },
      );
      const job = await eventually(
        () =>
          page.evaluate(
            async (id) =>
              (await import("/src/lib/api/imports.ts")).getChatRelocation(id),
            admitted.id,
          ),
        (job) => assert.equal(job.state, "succeeded", JSON.stringify(job)),
        60_000,
      );
      assert.equal(job.sourcePlacement.workerId, workerId);
      assert.equal(job.sourcePlacement.worktreeId, before.id);
      assert.equal(job.targetPlacement.workerId, targetWorkerId);
      assert.equal(job.targetPlacement.worktreeId, target.id);
      const observed = await page.evaluate(
        async ({ projectId, worktreeId }) =>
          (await window.folderWire.getProjectWorktreeWireList(projectId)).find(
            ({ id }) => id === worktreeId,
          )?.head,
        { projectId, worktreeId: before.id },
      );
      assert.equal(observed, target.head);
      return {
        jobId: job.id,
        sourceWorker: job.sourcePlacement.workerId,
        targetWorker: job.targetPlacement.workerId,
        targetWorktree: job.targetPlacement.worktreeId,
        sourceRevisionBeforeRequest: before.head,
        sourceRevisionAfterRequest: observed,
      };
    },
    async close() {
      await worker?.close();
    },
  };
}
