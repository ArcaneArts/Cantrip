import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildCantripCua } from "./build.mjs";
import { developmentCuaPaths, installDevelopmentCua } from "./development.mjs";
import { withInstallationLock } from "./install-lock.mjs";
import { FramedCuaProcess } from "./wire.mjs";

test(
  "lost lock cancels installation and preserves the previous helper",
  { timeout: 120_000 },
  async () => {
    const fixture = await mkdtemp(
      path.join(os.tmpdir(), "cantrip-cua-lost-lock-"),
    );
    try {
      const root = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../..",
      );
      const binary = buildCantripCua(root);
      const paths = developmentCuaPaths({
        homeDirectory: fixture,
        environment: {},
      });
      await mkdir(paths.directory, { recursive: true });
      await writeFile(paths.binary, "previous helper sentinel");
      await writeFile(
        paths.configuration,
        '{"version":1,"signingIdentity":null}\n',
      );
      let holder;
      await assert.rejects(
        installDevelopmentCua(binary, {
          homeDirectory: fixture,
          environment: {},
          runLocked(source, lockPath, action) {
            return withInstallationLock(source, lockPath, action, {
              spawnProcess(...args) {
                holder = spawn(...args);
                return holder;
              },
            });
          },
          async runSmoke(_source, { signal }) {
            const aborted = new Promise((resolve) =>
              signal.addEventListener("abort", resolve, { once: true }),
            );
            holder.kill("SIGKILL");
            await aborted;
            // Simulate a completed observation; installation must still refuse to
            // commit because its real lock-holder lifetime ended during the work.
          },
        }),
        /installation lock was lost/,
      );
      assert.equal(
        await readFile(paths.binary, "utf8"),
        "previous helper sentinel",
      );
      assert.equal(
        await readFile(paths.configuration, "utf8"),
        '{"version":1,"signingIdentity":null}\n',
      );
      await withInstallationLock(
        binary,
        path.join(paths.directory, ".installation.lock"),
        async (signal) => {
          assert.equal(signal.aborted, false);
        },
      );
    } finally {
      await rm(fixture, { force: true, recursive: true });
    }
  },
);

test(
  "smoke cancellation aborts real child requests and disposes the process",
  { timeout: 5000 },
  async () => {
    for (const initiallyAborted of [false, true]) {
      const lifetime = new AbortController();
      if (initiallyAborted) lifetime.abort();
      const child = new FramedCuaProcess(process.execPath, {
        args: ["-e", "process.stdin.resume()"],
        signal: lifetime.signal,
      });
      try {
        const request = child.request({ operation: "capabilities.get" });
        lifetime.abort();
        await assert.rejects(request, /smoke was cancelled/);
      } finally {
        await child.dispose();
      }
    }
  },
);
