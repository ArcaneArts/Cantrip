// A real Git fsmonitor hook holds the production workspace snapshot after
// inference capacity is granted and before the worker forwards native input.
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";

const execute = promisify(execFile);
export async function prestartPreparationFixture(directory) {
  await execute("git", ["init", "--quiet", "--initial-branch=main", directory]);
  await writeFile(
    path.join(directory, "prestart-fixture.txt"),
    "Owned durable preparation fixture.\n",
  );
  await execute("git", ["-C", directory, "add", "prestart-fixture.txt"]);
  await execute("git", [
    "-C",
    directory,
    "-c",
    "user.name=Suspension fixture",
    "-c",
    "user.email=suspension@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "-m",
    "Preparation fixture baseline",
  ]);
  const control = path.join(directory, ".git", "cantrip-prestart-preparation");
  await mkdir(control, { recursive: true });
  const armed = path.join(control, "armed");
  const entered = path.join(control, "entered.jsonl");
  const hook = path.join(
    directory,
    ".git",
    "hooks",
    "cantrip-prestart-fsmonitor",
  );
  await writeFile(
    hook,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const control = path.resolve(__dirname, "..", "cantrip-prestart-preparation");
const armed = path.join(control, "armed");
if (fs.existsSync(armed)) {
  fs.appendFileSync(path.join(control, "entered.jsonl"), JSON.stringify({ pid: process.pid, parent: process.ppid }) + "\\n");
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (fs.existsSync(armed)) Atomics.wait(wait, 0, 0, 25);
}
process.stdout.write("cantrip-prestart-" + Date.now() + "\\0");
`,
  );
  await chmod(hook, 0o755);
  await execute("git", ["-C", directory, "config", "core.fsmonitor", hook]);
  await execute("git", [
    "-C",
    directory,
    "config",
    "core.fsmonitorHookVersion",
    "2",
  ]);
  return {
    async arm() {
      await rm(entered, { force: true });
      await writeFile(armed, "owned preparation fixture\n");
    },
    entered: () =>
      eventually(
        async () => {
          try {
            return (await readFile(entered, "utf8"))
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line));
          } catch (error) {
            if (error.code === "ENOENT") return [];
            throw error;
          }
        },
        (value) =>
          assert.ok(
            value.length > 0,
            "The actual production Git snapshot reached its held fsmonitor hook",
          ),
      ),
    release: () => rm(armed, { force: true }),
    released: (owners) =>
      eventually(
        () =>
          owners.every(({ parent }) => {
            try {
              process.kill(parent, 0);
              return false;
            } catch (error) {
              if (error.code === "ESRCH") return true;
              throw error;
            }
          }),
        (value) =>
          assert.equal(
            value,
            true,
            "The actual Git snapshot subprocess exited after its hook was released",
          ),
      ),
  };
}
