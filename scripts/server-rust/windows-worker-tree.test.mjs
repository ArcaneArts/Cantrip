import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import {
  ownedWindowsWorkerProcesses,
  terminateWindowsWorkerTree,
} from "./windows-worker-tree.mjs";

test("Windows ownership rejects reused parent IDs and keeps later descendants", () => {
  const root = { id: 5344, parent: 2000, created: "639293815800000000" };
  const child = { id: 8000, parent: 5344, created: "639293815800000001" };
  const leaf = { id: 8004, parent: 8000, created: "639293815800000002" };
  // These four timestamps are from the failed Windows Task fixture. They
  // predate its 09:33 worker startup and cannot belong to that worker.
  const earlier = [
    { id: 6576, parent: 5344, created: "639293807738768980" },
    { id: 6604, parent: 5344, created: "639293807738866520" },
    { id: 6724, parent: 6604, created: "639293807739227910" },
    { id: 5464, parent: 6604, created: "639293807739375110" },
  ];
  const oneTickEarlier = {
    id: 8008,
    parent: 5344,
    created: "639293815799999999",
  };
  const unrelatedLaterChild = {
    id: 8012,
    parent: 6576,
    created: "639293815800000003",
  };
  assert.deepEqual(
    ownedWindowsWorkerProcesses(
      [leaf, unrelatedLaterChild, ...earlier, oneTickEarlier, root, child],
      root.id,
    ),
    [leaf, root, child],
  );
});

test(
  "Windows teardown observes and terminates an actual three-generation tree",
  { skip: process.platform !== "win32", timeout: 45000 },
  async (t) => {
    const leaf = "setInterval(() => {}, 1000)";
    const middle = `
      const { spawn } = require('node:child_process');
      const leaf = spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], { stdio: 'ignore' });
      leaf.once('spawn', () => process.send({ leaf: leaf.pid }));
      setInterval(() => {}, 1000);
    `;
    const parent = `
      const { spawn } = require('node:child_process');
      const middle = spawn(process.execPath, ['-e', ${JSON.stringify(middle)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      middle.once('message', (message) => process.send({ middle: middle.pid, ...message }));
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["-e", parent], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const completion = once(child, "close");
    try {
      const [descendants] = await once(child, "message", {
        signal: AbortSignal.timeout(15000),
      });
      assert.ok(descendants.middle > 0 && descendants.leaf > 0);
      const verify = await terminateWindowsWorkerTree(
        child.pid,
        Date.now() + 30000,
      );
      const [code, signal] = await completion;
      assert.equal(code, 1);
      assert.equal(signal, null);
      const result = await verify();
      assert.ok(result.observedProcesses >= 3);
      assert.deepEqual(result.remaining, []);
      t.diagnostic(JSON.stringify(result));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const verify = await terminateWindowsWorkerTree(
          child.pid,
          Date.now() + 30000,
        );
        await completion;
        await verify();
      }
    }
  },
);
