import assert from "node:assert/strict";
import { revision } from "./chat-relocation-http-worker.mjs";

export async function relocationSourceRevision({
  fixture,
  state,
  reset,
  target,
  waitJob,
}) {
  const missingSource = async () => {
    await reset();
    state.mode = "success";
    await fixture.sql([
      "UPDATE project_worktrees SET head=NULL WHERE id='github-alpha-main'",
    ]);
  };
  const durable = async () =>
    (
      await fixture.sql(
        [],
        [
          `SELECT jsonb_build_object('head',w.head,
                  'jobs',(SELECT count(*) FROM chat_relocation_jobs),
                  'requiredRevision',(SELECT required_revision FROM chat_relocation_snapshots LIMIT 1))::text result
             FROM project_worktrees w WHERE w.id='github-alpha-main'`,
        ],
      )
    )[0];
  const submit = async (name, key, status) => {
    await fixture.observe(name, "POST", "/api/chats/chat/relocations", {
      status,
      csrf: !!fixture.client().csrf,
      json: { approved: true, idempotencyKey: key, target },
    });
    return fixture.records.get(name);
  };
  const unrecorded = { head: null, jobs: 0, requiredRevision: null };

  await missingSource();
  state.heads.alpha = null;
  assert.deepEqual(await submit("unborn source response", "unborn", 409), {
    error: "The source worktree revision has not been observed yet.",
  });
  assert.equal(state.statusCounts.alpha, 1);
  assert.deepEqual(await durable(), unrecorded);

  await missingSource();
  state.beforeSourceStatus = () =>
    fixture.sql([
      "UPDATE chats SET placement_revision=placement_revision+1 WHERE id='chat'",
    ]);
  assert.deepEqual(
    await submit("relocation binding moved during observation", "stale", 409),
    { error: "The source placement changed before relocation was admitted." },
  );
  assert.equal(state.statusCounts.alpha, 1);
  assert.deepEqual(await durable(), unrecorded);

  await missingSource();
  const job = await submit("read unobserved source revision", "recover", 202);
  await waitJob(job.id, "succeeded");
  assert.deepEqual(await durable(), {
    head: revision,
    jobs: 1,
    requiredRevision: revision,
  });
  const sourceReads = state.statusCounts.alpha;
  assert.equal(sourceReads, 2, "one admission and one execution status read");
  const replay = await submit("replay observed relocation", "recover", 202);
  assert.equal(replay.id, job.id);
  assert.equal(state.statusCounts.alpha, sourceReads);

  await missingSource();
  const newer = "b".repeat(40);
  state.beforeSourceStatus = async () => {
    await fixture.sql([
      `UPDATE project_worktrees SET head='${newer}' WHERE id='github-alpha-main'`,
    ]);
    state.heads = { alpha: newer, beta: newer };
  };
  const newerJob = await submit(
    "keep concurrently recorded HEAD",
    "newer",
    202,
  );
  await waitJob(newerJob.id, "succeeded");
  assert.deepEqual(await durable(), {
    head: newer,
    jobs: 1,
    requiredRevision: newer,
  });
  return {
    unbornGitHead: "worker queried and original 409 preserved",
    changedPlacement: "409 and no saved observation or job",
    missingHead: "observed, persisted, and used for relocation",
    idempotentReplay: "same job and no second admission observation",
    concurrentHead: "existing newer revision preserved and used",
  };
}
