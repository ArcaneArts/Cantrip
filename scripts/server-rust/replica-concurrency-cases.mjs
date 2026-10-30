import assert from "node:assert/strict";
import { projectLabel } from "./security-fixtures.mjs";

export async function replicaConcurrencyCases({
  fixture,
  visit,
  read,
  until,
  waitJob,
  commands,
  releases,
  repository,
}) {
  const projects = [],
    jobs = [];
  const before = commands.length;
  for (let index = 0; index < 5; index++) {
    const id = `44444444-4444-4444-8444-${String(index + 1).padStart(12, "0")}`;
    projects.push(id);
    await visit(
      `capacity import ${index}`,
      "POST",
      "/api/projects/from-github",
      {
        status: 202,
        json: {
          id,
          workerId: "replica-a",
          nameProtection: projectLabel,
          repositoryBlindIndex: Buffer.alloc(32, 100 + index).toString(
            "base64url",
          ),
          repositoryId: repository,
          nameWithOwner: repository,
          url: repository,
          placement: {
            mode: "managed-link",
            path: "ctrr_" + Buffer.alloc(32, 150 + index).toString("base64url"),
          },
        },
      },
    );
    const [job] = await read(`/api/projects/${id}/replica-jobs`);
    assert.ok(job);
    jobs.push(job);
  }
  const activeCommands = () => commands.slice(before);
  await until(activeCommands, (values) => assert.equal(values.length, 4));
  const states = await until(
    () =>
      Promise.all(
        jobs.map((job) => read(`/api/project-replica-jobs/${job.id}`)),
      ),
    (values) => {
      assert.equal(
        values.filter(
          (job) => job.state === "running" && job.progress.percent === 25,
        ).length,
        4,
      );
      assert.equal(
        values.filter((job) => job.state === "queued" && job.attempt === 0)
          .length,
        1,
      );
    },
  );
  assert.equal(releases.size, 4, "four worker handlers are held at capacity");
  const first = states.find((job) => job.state === "running");
  releases.get(first.id)();
  releases.delete(first.id);
  await waitJob(first.id, "succeeded");
  await until(activeCommands, (values) => assert.equal(values.length, 5));
  await until(
    () => releases.size,
    (size) => assert.equal(size, 4),
  );
  for (const [id, release] of releases) {
    release();
    releases.delete(id);
  }
  for (const [index, job] of jobs.entries()) {
    const completed = await waitJob(job.id, "succeeded");
    assert.equal(completed.attempt, 1);
    assert.equal(completed.stateRevision, 4);
    assert.equal(completed.error, null);
    await visit(
      `capacity completion ${index}`,
      "GET",
      `/api/project-replica-jobs/${job.id}`,
    );
  }
  const observedCommands = activeCommands();
  assert.equal(
    observedCommands.length,
    5,
    "each admitted job dispatches exactly once",
  );
  assert.deepEqual(
    new Set(observedCommands.map(({ command }) => command.projectId)),
    new Set(projects),
  );
  return {
    before,
    runningAtCapacity: 4,
    queuedAtCapacity: 1,
    commands: observedCommands.sort((a, b) =>
      a.command.projectId.localeCompare(b.command.projectId),
    ),
  };
}
