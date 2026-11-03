import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { withInstanceLock } from "../scripts/lock.mjs";
import { run } from "../scripts/os.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};

test("a second foreground owner fails without entering or releasing the first lock", async () => {
  const name = `test-${randomUUID()}`;
  const entered = deferred(),
    release = deferred();
  const first = withInstanceLock(name, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  try {
    await assert.rejects(
      withInstanceLock(name, () => assert.fail("overlapping owner"), {
        wait: false,
      }),
      /already running/,
    );
    await assert.rejects(
      withInstanceLock(name, () => assert.fail("lock lost"), { wait: false }),
      /already running/,
    );
  } finally {
    release.resolve();
    await first;
  }
  await withInstanceLock(name, () => {}, { wait: false });
});

test("cancelling a queued rebuild never runs its action and leaves the owner intact", async () => {
  const name = `test-${randomUUID()}`;
  const entered = deferred(),
    release = deferred();
  const first = withInstanceLock(name, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const controller = new AbortController();
  const queued = assert.rejects(
    withInstanceLock(name, () => assert.fail("cancelled action ran"), {
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  try {
    await delay(50);
    controller.abort();
    await queued;
    await assert.rejects(
      withInstanceLock(name, () => assert.fail("owner lost"), { wait: false }),
      /already running/,
    );
  } finally {
    release.resolve();
    await first;
  }
  await withInstanceLock(name, () => {});
});

test("command cancellation settles only once its child has exited", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cantrip-os-child-"));
  const pidFile = join(dir, "pid");
  const controller = new AbortController();
  const result = assert.rejects(
    run(
      process.execPath,
      [
        "-e",
        `require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);`,
        pidFile,
      ],
      { capture: true, signal: controller.signal },
    ),
    { name: "AbortError" },
  );
  try {
    let pid;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        pid = Number(await readFile(pidFile, "utf8"));
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await delay(20);
    }
    assert.ok(pid, "child started");
    controller.abort();
    await result;
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    controller.abort();
    await result;
    await rm(dir, { recursive: true, force: true });
  }
});
