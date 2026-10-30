import assert from "node:assert/strict";
import { projectLabel } from "./security-fixtures.mjs";

// Real production two-minute lease and 30-second sweep. A mismatched worker
// completion releases the executor but cannot settle or extend its stale lease.
export async function discoveryExpiryCases({
  fixture,
  visit,
  read,
  until,
  live,
  name,
  handle,
  counts,
  workerId,
  setHandler,
}) {
  const workspace = "77777777-7777-4777-8777-000000000201";
  const url = `/api/workspaces/${workspace}/repository-discovery`;
  const commands = [];
  let firstAt,
    release,
    heartbeatError,
    heartbeatPending,
    sequence = 0;
  const gate = new Promise((resolve) => (release = resolve));
  setHandler(async (command) => {
    if (command.type === "repository.operation")
      return {
        operationId: command.operationId,
        protectedResponse: projectLabel.protectedLabel,
        workspaceRootAttachment: {
          rootPathHandle: handle(200),
          displayHandle: handle(201),
        },
      };
    assert.equal(command.type, "workspace.repositories.discover");
    commands.push(command);
    if (command.attempt === 1) firstAt = Date.now();
    else await gate;
    return {
      jobId: command.jobId,
      attempt: command.attempt === 1 ? command.attempt + 1 : command.attempt,
      counts: counts(1),
      truncated: false,
      diagnosticCode: null,
      candidates: [
        {
          path: handle(202),
          displayPath: handle(203),
          originUrl: null,
          github: null,
          repositoryFingerprint: "e".repeat(64),
          classification: "local-git",
          diagnosticCode: null,
        },
      ],
    };
  });
  const heartbeat = setInterval(() => {
    if (heartbeatPending) return;
    heartbeatPending = live
      .ping("discovery expiry heartbeat " + ++sequence)
      .catch((error) => (heartbeatError = error))
      .finally(() => (heartbeatPending = undefined));
  }, 10000);
  try {
    await visit("expiry attach workspace", "POST", "/api/workspaces/attached", {
      status: 201,
      json: {
        id: workspace,
        nameProtection: {
          ...name,
          blindIndex: Buffer.alloc(32, 199).toString("base64url"),
        },
        storage: { kind: "attached", workerId },
        operationId: workspace,
        protectedRequest: projectLabel.protectedLabel,
      },
    });
    await until(
      () => commands.length,
      (n) => assert.equal(n, 1),
    );
    const stale = await visit(
      "expiry mismatched result leaves running scan",
      "GET",
      url,
    );
    assert.equal(stale.job.state, "running");
    assert.equal(stale.job.attempt, 1);
    assert.equal(stale.job.stateRevision, 2);
    assert.deepEqual(stale.candidates, []);
    const recovered = await until(
      () => read(url),
      (snapshot) => {
        assert.equal(snapshot.job.state, "running");
        assert.equal(snapshot.job.attempt, 2);
        assert.equal(snapshot.job.stateRevision, 4);
        assert.equal(commands.length, 2);
      },
      180000,
    );
    const elapsed = Date.now() - firstAt;
    assert.ok(elapsed >= 120000, "recovery waits for the real original lease");
    fixture.discoveryExpiryMilliseconds = elapsed;
    assert.deepEqual(
      commands.map((c) => c.attempt),
      [1, 2],
    );
    assert.equal(commands[0].jobId, commands[1].jobId);
    assert.deepEqual(recovered.candidates, []);
    release();
    const completed = await until(
      () => read(url),
      (snapshot) => assert.equal(snapshot.job.state, "succeeded"),
    );
    assert.equal(completed.job.attempt, 2);
    assert.equal(completed.job.stateRevision, 5);
    assert.equal(completed.candidates.length, 1);
    await visit("expiry recovered result committed once", "GET", url);
    await live.ping("discovery expiry final barrier");
    const events = live.history
      .filter(
        (e) =>
          e.type === "event" &&
          e.resource === "workspace-repository-discovery-job" &&
          e.entityId === workspace &&
          e.revision !== null,
      )
      .map(({ scope, resource, action, entityId, revision, payload }) => ({
        scope,
        resource,
        action,
        entityId,
        revision,
        payload,
      }));
    assert.deepEqual(
      events.map((e) => e.revision),
      [1, 2, 4, 5],
    );
    return fixture.normalize({
      elapsedAtLeastMs: 120000,
      stale,
      recovered,
      completed,
      commands,
      events,
    });
  } finally {
    release();
    clearInterval(heartbeat);
    await heartbeatPending;
    if (heartbeatError) throw heartbeatError;
  }
}
