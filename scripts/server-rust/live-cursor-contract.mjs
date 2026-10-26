// Validate the comparison harness against real publications, including controls
// proving that it cannot account away a stale/future cursor or another resource.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HttpFixture } from "./http-fixture.mjs";
import { LiveProbe, initialize } from "./live-sockets.mjs";
import { LiveCursorObserver } from "./live-cursor-observer.mjs";

const at = process.argv.indexOf("--report");
const target = at < 0 ? undefined : process.argv[at + 1];
const root = await mkdtemp(path.join(tmpdir(), "cantrip-cursor-contract-"));
const fixture = new HttpFixture({
  kind: "node",
  root,
  name: "cursor-controls",
  databaseMode: "pglite",
  environment: { CANTRIP_BANDWIDTH_USAGE_FLUSH_THRESHOLD_BYTES: "1024" },
});
const report = {
  suite: "live-cursor-comparison-controls",
  completeReplacement: false,
};
let observer, probe, failure;
try {
  await fixture.start();
  observer = await new LiveCursorObserver(fixture).open();
  probe = await new LiveProbe(fixture).open();
  probe.send({ ...initialize(), extra: "a".repeat(4096) });
  assert.equal((await probe.message()).code, "invalid-message");
  await probe.initialized();
  await probe.close();
  probe = undefined;
  report.publication = await observer.waitForPublication();
  probe = await new LiveProbe(fixture).open();
  const minimum = observer.beforeSend();
  const ready = await probe.initialized();
  report.valid = await observer.verifyFrame(ready, minimum);
  assert.ok(report.valid.rawCurrentCursor > observer.baseline.currentCursor);
  await assert.rejects(
    observer.verifyFrame({ ...ready, currentCursor: minimum - 1 }, minimum),
    assert.AssertionError,
  );
  report.staleCursorRejected = true;
  await assert.rejects(
    observer.verifyFrame({ ...ready, serverEpoch: randomUUID() }, minimum),
    assert.AssertionError,
  );
  report.wrongEpochRejected = true;
  await assert.rejects(
    observer.verifyFrame(
      { ...ready, currentCursor: Number.MAX_SAFE_INTEGER },
      minimum,
    ),
    /Live socket timed out/,
  );
  report.unobservedCursorRejected = true;
  await fixture.observe(
    "actual worker publication",
    "POST",
    "/api/workers/enrollment-codes",
    { json: {}, status: 201 },
  );
  report.unrelated = await observer.probe.message(
    (frame) => frame.type === "event" && frame.resource === "worker",
  );
  assert.throws(() => observer.collect(), assert.AssertionError);
  report.unrelatedPublicationRejected = true;
} catch (error) {
  failure = error;
  report.failure = error.stack;
} finally {
  // The forbidden real publication has already been asserted. Close its socket
  // directly instead of running the same intentionally failing collect twice.
  const cleanup = await Promise.allSettled([
    probe?.close(),
    observer?.probe?.close(),
  ]);
  cleanup.push(...(await Promise.allSettled([fixture.close()])));
  const errors = cleanup
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length) {
    report.cleanupFailures = errors.map((error) => error.stack);
    failure ??= new AggregateError(errors, "Cursor control cleanup failed");
  }
  if (target) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(report, null, 2) + "\n");
  }
  if (failure) console.error(`Retained failed cursor fixtures: ${root}`);
  else await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(JSON.stringify(report));
