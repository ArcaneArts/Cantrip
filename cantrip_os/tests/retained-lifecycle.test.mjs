import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  changeRetainedContainer,
  observeRetainedContainer,
  DockerApiError,
  DockerDeliveryError,
} from "../host/index.mjs";

async function fixture(action = "restart") {
  const directory = await mkdtemp(join(tmpdir(), "cantrip-retained-"));
  const input = {
    operationId: randomUUID(),
    action,
    container: `fixture-${randomUUID()}`,
    expectedContainerId: "a".repeat(64),
    journalPath: join(directory, "operation.json"),
  };
  const actual = {
    Id: input.expectedContainerId,
    Name: input.container,
    State: {
      Running: true,
      Status: "running",
      StartedAt: "initial",
      FinishedAt: "never",
    },
  };
  const posts = [];
  let loseReply = false,
    refuse = false,
    missing = false;
  const engine = {
    inspect: async () => {
      if (missing) throw new DockerApiError(404, "No such container");
      return structuredClone(actual);
    },
    request: async (method, url) => {
      posts.push({ method, url });
      if (refuse) throw new DockerApiError(409, "Actual Engine refusal");
      const stopped = url.includes("/stop?");
      actual.State = {
        Running: !stopped,
        Status: stopped ? "exited" : "running",
        StartedAt: stopped ? actual.State.StartedAt : randomUUID(),
        FinishedAt: stopped ? randomUUID() : actual.State.FinishedAt,
      };
      if (loseReply)
        throw new DockerDeliveryError("Reply disconnected after mutation");
      return null;
    },
  };
  return {
    directory,
    input,
    actual,
    posts,
    engine,
    lose: () => {
      loseReply = true;
    },
    refuse: () => {
      refuse = true;
    },
    remove: () => {
      missing = true;
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

for (const action of ["start", "stop", "restart"])
  test(`retained ${action} addresses the admitted ID once and retains a private receipt`, async () => {
    const f = await fixture(action);
    try {
      const result = await changeRetainedContainer(f.engine, f.input);
      assert.equal(result.operation.state, "ready");
      assert.equal(
        result.operation.completionEvidence,
        "acknowledged-and-observed",
      );
      assert.equal(f.posts.length, 1);
      assert.ok(
        f.posts[0].url.startsWith(
          `/containers/${f.input.expectedContainerId}/`,
        ),
      );
      const repeated = await changeRetainedContainer(f.engine, f.input);
      assert.deepEqual(repeated.operation, result.operation);
      assert.equal(f.posts.length, 1);
      if (process.platform !== "win32")
        assert.equal((await stat(f.input.journalPath)).mode & 0o777, 0o600);
      await assert.rejects(
        changeRetainedContainer(f.engine, {
          ...f.input,
          expectedContainerId: "b".repeat(64),
        }),
        /another target or action/,
      );
      assert.equal(f.posts.length, 1);
    } finally {
      await f.cleanup();
    }
  });

test("a lost mutation reply is reconciled by current state without a second POST", async () => {
  const f = await fixture();
  try {
    f.lose();
    assert.equal(
      (await changeRetainedContainer(f.engine, f.input)).operation.state,
      "unknown",
    );
    const recovered = await observeRetainedContainer(f.engine, f.input);
    assert.equal(recovered.operation.state, "ready");
    assert.equal(recovered.operation.completionEvidence, "observed-state");
    assert.equal(f.posts.length, 1);
    f.remove();
    const offline = await observeRetainedContainer(f.engine, f.input);
    assert.equal(offline.operation.state, "ready");
    assert.equal(offline.observation, null);
    assert.match(offline.observationError, /No such container/);
    assert.equal(f.posts.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("a new container at the same name is rejected before mutation", async () => {
  const f = await fixture();
  try {
    f.actual.Id = "b".repeat(64);
    const result = await changeRetainedContainer(f.engine, f.input);
    assert.equal(result.operation.state, "failed");
    assert.match(result.operation.error, /container changed/);
    assert.equal(f.posts.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("actual Engine refusal is a saved failure and is not automatically retried", async () => {
  const f = await fixture();
  try {
    f.refuse();
    const result = await changeRetainedContainer(f.engine, f.input);
    assert.equal(result.operation.state, "failed");
    assert.equal(result.operation.error, "Actual Engine refusal");
    assert.equal(
      (await changeRetainedContainer(f.engine, f.input)).operation.state,
      "failed",
    );
    assert.equal(f.posts.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("death before dispatch and an unobserved restart never authorize replay", async () => {
  const f = await fixture();
  try {
    assert.equal(await observeRetainedContainer(f.engine, f.input), null);
    const record = {
      version: 1,
      request: {
        operationId: f.input.operationId,
        action: f.input.action,
        container: f.input.container,
        expectedContainerId: f.input.expectedContainerId,
      },
      state: "running",
      phase: "reserved",
      before: null,
      after: null,
      error: null,
    };
    await writeFile(f.input.journalPath, JSON.stringify(record));
    assert.equal(
      (await changeRetainedContainer(f.engine, f.input)).operation.state,
      "unknown",
    );
    assert.equal(f.posts.length, 0);
    const saved = JSON.parse(await readFile(f.input.journalPath, "utf8"));
    saved.phase = "mutation-requested";
    saved.before = { startedAt: f.actual.State.StartedAt };
    await writeFile(f.input.journalPath, JSON.stringify(saved));
    assert.equal(
      (await changeRetainedContainer(f.engine, f.input)).operation.state,
      "unknown",
    );
    assert.equal(f.posts.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("a damaged completion cannot manufacture success or authorize a new mutation", async () => {
  const f = await fixture();
  try {
    await changeRetainedContainer(f.engine, f.input);
    const record = JSON.parse(await readFile(f.input.journalPath, "utf8"));
    record.after = null;
    await writeFile(f.input.journalPath, JSON.stringify(record));
    await assert.rejects(
      observeRetainedContainer(f.engine, f.input),
      /no matching transition evidence/,
    );
    await assert.rejects(
      changeRetainedContainer(f.engine, f.input),
      /no matching transition evidence/,
    );
    assert.equal(f.posts.length, 1);
  } finally {
    await f.cleanup();
  }
});
