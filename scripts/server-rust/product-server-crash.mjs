import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function crashProductServer(child, kind) {
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  const closed = once(child, "close");
  const helper =
    kind === "rust" && process.env.CANTRIP_TEST_SERVER_SIGKILL_HELPER;
  if (helper) {
    // Container launchers report the exit of the packaged server they supervise.
    const [exit] = await Promise.all([
      closed,
      execute(helper, [String(child.pid)], { timeout: 30_000 }),
    ]);
    assert.deepEqual(exit, [137, null]);
  } else {
    assert.equal(child.kill("SIGKILL"), true);
    assert.deepEqual(await closed, [null, "SIGKILL"]);
  }
}
