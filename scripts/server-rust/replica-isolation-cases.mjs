import assert from "node:assert/strict";

// Real second-account requests target existing owner resources, not missing IDs.
export async function replicaIsolationCases({
  fixture,
  visit,
  read,
  replicasPath,
  firstReplica,
  first,
  repository,
  nextRevision,
  commands,
  id,
}) {
  await visit("replica other account", "POST", "/api/auth/register", {
    client: "replica-other",
    csrf: false,
    status: 201,
    json: {
      email: "replica-other@example.invalid",
      displayName: "Other account",
      password: "Replica-isolation-password-123!",
    },
  });
  const beforeJob = await read(`/api/project-replica-jobs/${first.id}`);
  const beforeReplicas = await read(replicasPath);
  const beforeCommands = commands.length;
  const replica = `${replicasPath}/${firstReplica.id}`;
  const job = `/api/project-replica-jobs/${first.id}`;
  const cases = [
    ["list", "GET", replicasPath],
    ["detail", "GET", replica],
    ["jobs", "GET", `/api/projects/${id}/replica-jobs`],
    ["job", "GET", job],
    [
      "provision",
      "POST",
      replicasPath,
      {
        workerId: "replica-a",
        repository,
        idempotencyKey: "foreign-provision",
      },
    ],
    [
      "synchronize",
      "POST",
      `${replica}/synchronize`,
      {
        repository,
        expectedRevision: nextRevision,
        idempotencyKey: "foreign-sync",
      },
    ],
    [
      "remove",
      "POST",
      `${replica}/remove`,
      {
        repository,
        deleteLocalFiles: true,
        idempotencyKey: "foreign-remove",
      },
    ],
    ["repair", "POST", `${replica}/repair-link`],
    [
      "retry",
      "POST",
      `${job}/retry`,
      { stateRevision: beforeJob.stateRevision },
    ],
    [
      "cancel",
      "POST",
      `${job}/cancel`,
      { stateRevision: beforeJob.stateRevision },
    ],
  ];
  for (const [label, method, route, json] of cases) {
    await visit(`replica isolation ${label}`, method, route, {
      client: "replica-other",
      status: 404,
      json,
    });
  }
  assert.deepEqual(await read(job), beforeJob);
  assert.deepEqual(await read(replicasPath), beforeReplicas);
  assert.equal(
    commands.length,
    beforeCommands,
    "foreign calls dispatch no worker commands",
  );
}
