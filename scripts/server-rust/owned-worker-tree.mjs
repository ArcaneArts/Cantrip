// POSIX acceptance supervision. The launcher must give this worker a separate
// process group; shared native PTYs may create additional owned groups.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
async function processes() {
  const { stdout } = await execute("ps", [
    "-axo",
    "pid=,ppid=,pgid=,stat=,comm=",
  ]);
  return stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, parent, group, state, ...command] = line.trim().split(/\s+/);
      return {
        pid: Number(pid),
        parent: Number(parent),
        group: Number(group),
        state,
        command: command.join(" "),
      };
    });
}
function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

export async function killOwnedWorkerTree(
  child,
  { executableRoots = [] } = {},
) {
  // Managed tool daemons can detach into a new group and be reparented before
  // inspection. Their executable still belongs to this run's isolated storage.
  const roots = (
    await Promise.all(
      executableRoots.map(async (root) => [
        path.resolve(root),
        await realpath(root).catch(() => path.resolve(root)),
      ]),
    )
  )
    .flat()
    .map((root) => root + path.sep);
  const scopedExecutable = (row) =>
    roots.some((root) => row.command.startsWith(root));
  const closed =
    child.exitCode === null && child.signalCode === null
      ? once(child, "close")
      : Promise.resolve();
  const owned = new Map(),
    groups = new Set([child.pid]);
  const deadline = Date.now() + 15000;
  let frozen = [];
  // Freeze supervisors before collecting children. Repeat until every owned
  // process is stopped; include orphaned members of the worker's own groups.
  signal(child.pid, "SIGSTOP");
  try {
    for (;;) {
      const rows = await processes();
      const hostGroup = rows.find((row) => row.pid === process.pid)?.group;
      const root = rows.find((row) => row.pid === child.pid);
      if (root)
        assert.equal(
          root.group,
          child.pid,
          "The worker owns an isolated process group",
        );
      let changed;
      do {
        changed = false;
        for (const row of rows) {
          if (
            row.pid !== child.pid &&
            !owned.has(row.parent) &&
            !groups.has(row.group) &&
            !scopedExecutable(row)
          )
            continue;
          assert.notEqual(
            row.group,
            hostGroup,
            "Never signal the acceptance host group",
          );
          if (!owned.has(row.pid)) changed = true;
          owned.set(row.pid, row);
          groups.add(row.group);
        }
      } while (changed);
      frozen = rows.filter(
        (row) => owned.has(row.pid) || groups.has(row.group),
      );
      if (
        frozen.every(
          (row) => row.state.startsWith("T") || row.state.startsWith("Z"),
        )
      )
        break;
      for (const row of frozen) signal(row.pid, "SIGSTOP");
      if (Date.now() > deadline)
        throw new Error("Owned worker processes did not stop for termination");
      await delay(5);
    }
  } finally {
    for (const group of groups) signal(-group, "SIGKILL");
    await closed;
  }
  for (;;) {
    const live = (await processes()).filter(
      (row) =>
        (owned.has(row.pid) || groups.has(row.group)) &&
        !row.state.startsWith("Z"),
    );
    if (!live.length) break;
    if (Date.now() > deadline)
      throw new Error(
        "Owned worker processes survived SIGKILL: " + JSON.stringify(live),
      );
    await delay(10);
  }
  return { processes: frozen, groups: [...groups] };
}
