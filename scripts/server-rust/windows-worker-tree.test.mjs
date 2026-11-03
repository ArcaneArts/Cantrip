import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { terminateWindowsWorkerTree } from "./windows-worker-tree.mjs";

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
