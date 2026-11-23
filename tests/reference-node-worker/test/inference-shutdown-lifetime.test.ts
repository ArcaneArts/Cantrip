import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.each(["completed", "rejected"])(
  "keeps inference shutdown alive through native retirement and releases its reference when %s",
  async (outcome) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-inference-shutdown-"),
    );
    try {
      const driver = path.join(directory, "driver.mjs");
      await writeFile(
        driver,
        `
void (async () => {
  const { WorkerInferenceAdmission } = await import(process.argv[2]);
  const admission = new WorkerInferenceAdmission({
    serverId: "server", ownerId: "owner", workerId: "worker",
    workerGeneration: "generation",
  }, error => { throw error; }, {
    available: true,
    onLost() {},
    async prepare() { return {}; },
    retire() {
      console.log("retirement-started");
      return new Promise(resolve => setTimeout(() => {
        console.log("retirement-completed");
        resolve();
      }, 100).unref());
    },
    async journal() { return { version: 1, revision: 0, operations: {} }; },
    async close() {
      console.log("owner-closed");
      if (process.argv[3] === "rejected") throw new Error("Owner close rejected.");
    },
  });
  await admission.createRuntime().prepareNativeLaunch();
  const first = admission.close();
  if (admission.close() !== first) throw new Error("Shutdown must be shared.");
  try {
    await first;
    if (process.argv[3] === "rejected") throw new Error("Expected owner rejection.");
    console.log("shutdown-completed");
  } catch (error) {
    if (process.argv[3] !== "rejected" || error.message !== "Owner close rejected.") throw error;
    console.log("shutdown-rejected");
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
      );
      // A separate process is essential: the test runner's handles would keep an
      // incorrectly unreferenced shutdown alive and hide premature worker exit.
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          driver,
          new URL("../src/inference-admission.ts", import.meta.url).href,
          outcome,
        ],
        { timeout: 10_000 },
      );
      expect(stderr).toBe("");
      expect(stdout.trim().split("\n")).toEqual([
        "retirement-started",
        "retirement-completed",
        "owner-closed",
        `shutdown-${outcome}`,
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  10_000,
);
