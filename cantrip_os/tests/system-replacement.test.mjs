import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  replaceSystem,
  observeSystemReplacement,
  continueSystemReplacement,
} from "../host/index.mjs";
import { replacementFixture } from "./fixtures/system-replacement-engine.mjs";

const rollback = (f, result) => ({
  journalPath: join(f.directory, "rollback.json"),
  replacementJournalPath: f.input.journalPath,
  request: {
    action: "rollback",
    operationId: randomUUID(),
    container: f.input.request.container,
    instanceId: f.input.request.instanceId,
    scopeKey: "9".repeat(64),
    startTarget: true,
    replacementOperationId: f.input.request.operationId,
    replacementRequestSha256: result.operation.requestSha256,
    expectedOriginalId: f.oldId,
  },
});

test("lost creation cannot adopt copied labels under a different name or an ambiguous candidate", async () => {
  for (const kind of ["renamed", "ambiguous"]) {
    const f = await replacementFixture();
    try {
      f.lose("create");
      await replaceSystem(f.engine, f.input);
      if (kind === "renamed")
        f.containers.get(f.nextId).Name = "/another-generation";
      else
        f.containers.set("c".repeat(64), {
          ...structuredClone(f.containers.get(f.nextId)),
          Id: "c".repeat(64),
          Name: "/copied-candidate",
        });
      const count = f.effects.length;
      assert.equal(
        (await continueSystemReplacement(f.engine, f.input)).operation.state,
        "unknown",
      );
      assert.equal(f.effects.length, count);
      assert.equal(f.starts.has(f.nextId), false);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
  const f = await replacementFixture();
  try {
    await assert.rejects(
      replaceSystem(f.engine, {
        ...f.input,
        request: { ...f.input.request, container: 123 },
      }),
      /immutable system replacement admission/,
    );
    assert.equal(f.effects.length, 0);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("replacement retains both writable layers, exact mounts and policy and keeps history separate from availability", async () => {
  const f = await replacementFixture();
  try {
    const result = await replaceSystem(f.engine, f.input);
    assert.equal(result.operation.state, "ready");
    assert.equal(result.operation.targetContainerId, f.nextId);
    assert.equal(f.containers.get(f.oldId).State.Running, false);
    assert.equal(f.containers.get(f.oldId).HostConfig.RestartPolicy.Name, "no");
    const next = f.containers.get(f.nextId);
    assert.equal(next.HostConfig.RestartPolicy.Name, "always");
    assert.deepEqual(next.Config.Env, [
      "DEFAULT=checkpoint",
      "CUSTOM=retained",
    ]);
    assert.equal(next.HostConfig.Memory, f.original.HostConfig.Memory);
    assert.deepEqual(
      next.HostConfig.PortBindings,
      f.original.HostConfig.PortBindings,
    );
    assert.deepEqual(next.HostConfig.Binds, []);
    assert.equal(next.HostConfig.Mounts[0].Source, "retained");
    assert.equal(next.HostConfig.Mounts[0].VolumeOptions.NoCopy, true);
    assert.equal(f.starts.get(f.nextId), 1);
    const count = f.effects.length;
    assert.deepEqual(
      (await replaceSystem(f.engine, f.input)).operation,
      result.operation,
    );
    assert.equal(f.effects.length, count);
    f.unavailable();
    const offline = await observeSystemReplacement(f.engine, f.input);
    assert.deepEqual(offline.operation, result.operation);
    assert.match(offline.observationError, /disconnected/);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

for (const action of [
  "fence",
  "stop",
  "create",
  "rename-retained",
  "rename-target",
  "start",
  "policy",
])
  test(`lost ${action} reply is observed and only future unrequested steps continue`, async () => {
    const f = await replacementFixture();
    try {
      f.lose(action);
      const first = await replaceSystem(f.engine, f.input);
      assert.equal(first.operation.state, "unknown");
      const count = f.effects.length;
      await observeSystemReplacement(f.engine, f.input);
      assert.equal(f.effects.length, count);
      const ready = await continueSystemReplacement(f.engine, f.input);
      assert.equal(ready.operation.state, "ready");
      assert.equal(f.effects.filter((e) => e.action === action).length, 1);
      assert.equal(f.starts.get(f.nextId), 1);
      assert.equal(f.containers.get(f.oldId).State.Running, false);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });

test("rollback is a separate immutable admission retaining the replaced container", async () => {
  const f = await replacementFixture();
  try {
    const replaced = await replaceSystem(f.engine, f.input),
      input = rollback(f, replaced);
    const undone = await replaceSystem(f.engine, input);
    assert.equal(undone.operation.state, "ready");
    assert.equal(undone.operation.targetContainerId, f.oldId);
    assert.equal(
      f.containers.get(f.oldId).Name,
      `/${f.input.request.container}`,
    );
    assert.equal(f.starts.get(f.oldId), 2);
    assert.equal(f.containers.get(f.nextId).State.Running, false);
    assert.equal(
      f.containers.get(f.nextId).HostConfig.RestartPolicy.Name,
      "no",
    );
    const count = f.effects.length;
    assert.deepEqual(
      (await replaceSystem(f.engine, input)).operation,
      undone.operation,
    );
    assert.equal(f.effects.length, count);
    assert.deepEqual(
      (await observeSystemReplacement(f.engine, f.input)).operation,
      replaced.operation,
    );
    await assert.rejects(
      replaceSystem(f.engine, {
        ...input,
        request: { ...input.request, startTarget: false },
      }),
      /journal changed/,
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("failed startup and rejected candidate mounts preserve the original for explicit rollback", async () => {
  for (const failure of ["start", "mounts"]) {
    const f = await replacementFixture();
    try {
      if (failure === "start") f.refuse("start");
      else f.badMount();
      const replaced = await replaceSystem(f.engine, f.input);
      assert.notEqual(replaced.operation.state, "ready");
      if (failure === "start") assert.equal(replaced.operation.state, "failed");
      if (failure === "mounts") {
        const recovered = await replaceSystem(f.engine, rollback(f, replaced));
        assert.equal(recovered.operation.state, "ready");
        assert.equal(f.containers.get(f.oldId).State.Running, true);
        assert.equal(
          f.containers.get(f.oldId).Name,
          `/${f.input.request.container}`,
        );
      } else
        assert.equal(
          (await replaceSystem(f.engine, rollback(f, replaced))).operation
            .state,
          "ready",
        );
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test("an undelivered uncertain start is never replayed or bypassed by rollback", async () => {
  const f = await replacementFixture();
  try {
    f.before("start");
    const replaced = await replaceSystem(f.engine, f.input);
    assert.equal(replaced.operation.state, "unknown");
    const input = rollback(f, replaced),
      count = f.effects.length;
    assert.equal(
      (await replaceSystem(f.engine, input)).operation.state,
      "unknown",
    );
    assert.equal(f.effects.length, count);
    assert.equal(
      (await continueSystemReplacement(f.engine, f.input)).operation.state,
      "unknown",
    );
    assert.equal(f.effects.length, count);
    f.containers.get(f.nextId).State = {
      Running: true,
      Restarting: false,
      StartedAt: new Date().toISOString(),
    };
    assert.equal(
      (await continueSystemReplacement(f.engine, input)).operation.state,
      "ready",
    );
    assert.equal(
      f.effects.filter((e) => e.action === "start" && e.path.includes(f.nextId))
        .length,
      1,
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("private snapshots cannot become reusable base templates and foreign instance proof cannot activate", async () => {
  for (const mode of ["base", "linked-source", "foreign"]) {
    const f = await replacementFixture();
    try {
      if (mode === "base" || mode === "linked-source") {
        f.input.request.source = { kind: "base", imageId: f.target.Id };
        if (mode === "linked-source") {
          f.target.Config.Labels = {
            "io.cantrip.os": "foundation",
            "io.cantrip.os.source-mounts": JSON.stringify({ bindings: [] }),
          };
        }
      } else
        f.target.Config.Labels["io.cantrip.os.system.instance"] = randomUUID();
      const value = await replaceSystem(f.engine, f.input);
      assert.equal(value.operation.state, "unknown");
      assert.equal(f.effects.length, 0);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test("actual staged bytes are verified before a missing image upload and the original remains usable on corruption", async () => {
  const f = await replacementFixture();
  try {
    f.images.delete(f.target.Id);
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 317, 0x42);
    const path = join(f.directory, "verified.tar");
    await writeFile(path, bytes);
    f.input.request.archive = {
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const ready = await replaceSystem(f.engine, f.input);
    assert.equal(ready.operation.state, "ready");
    assert.equal(f.effects.filter((e) => e.action === "load").length, 1);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
  const g = await replacementFixture();
  try {
    g.images.delete(g.target.Id);
    const path = join(g.directory, "corrupt.tar");
    await writeFile(path, "corrupt");
    g.input.request.archive = { path, bytes: 99, sha256: "0".repeat(64) };
    assert.equal(
      (await replaceSystem(g.engine, g.input)).operation.state,
      "failed",
    );
    assert.equal(g.effects.length, 0);
    assert.equal(g.original.State.Running, true);
    const journal = JSON.parse(await readFile(g.input.journalPath, "utf8"));
    assert.equal(journal.steps.load.claimed, undefined);
  } finally {
    await rm(g.directory, { recursive: true, force: true });
  }
});
