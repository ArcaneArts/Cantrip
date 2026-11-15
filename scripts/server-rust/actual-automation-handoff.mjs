import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { automationDispatchWorkerEnvironment } from "./actual-automation-dispatch-interruption.mjs";
import { eventually, launchActualWorker } from "./full-worker.mjs";
import { normalizeProjectSourcePath } from "../../cantrip_worker/src/project-source-path.ts";

const postgres = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("postgres");

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
      const source = await page.evaluate(
        async ({ projectId, chatId }) => {
          const chats = await (
            await import("/src/lib/api/chats.ts")
          ).getChats(projectId);
          const chat = chats.find(({ id }) => id === chatId);
          const status = await (
            await import("/src/lib/api/worktrees.ts")
          ).getProjectWorktreeStatus(projectId, chat.activeWorktreeId);
          return {
            worktreeId: chat.activeWorktreeId,
            head: status.worktree.head,
          };
        },
        { projectId, chatId },
      );
      assert.equal(source.head, revision);
      // The direct Git fixture starts without a persisted source HEAD. Record
      // the real source worker revision before exercising relocation.
      const sql = postgres(fixture.environment.DATABASE_URL, { max: 1 });
      try {
        const [row] = await sql`
          UPDATE project_worktrees w SET head=COALESCE(w.head,${source.head})
          FROM chats c
          WHERE w.id=${source.worktreeId} AND c.active_worktree_id=w.id
            AND c.id=${chatId} AND c.project_id=${projectId}
            AND w.worker_id=${workerId}
          RETURNING w.head
        `;
        assert.equal(row?.head, revision);
      } finally {
        await sql.end({ timeout: 3 });
      }
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
      assert.equal(job.targetPlacement.workerId, targetWorkerId);
      assert.equal(job.targetPlacement.worktreeId, target.id);
      return {
        jobId: job.id,
        sourceWorker: job.sourcePlacement.workerId,
        targetWorker: job.targetPlacement.workerId,
        targetWorktree: job.targetPlacement.worktreeId,
      };
    },
    async close() {
      await worker?.close();
    },
  };
}
