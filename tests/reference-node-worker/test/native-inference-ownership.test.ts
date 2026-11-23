import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";

it("keeps shutdown alive until an idle keeper and its stdio close", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cantrip-owner-lifetime-"),
  );
  const driver = path.join(directory, "driver.mjs");
  const trace = path.join(directory, "trace.jsonl");
  try {
    // Node itself is the portable fixture executable. The real ownership
    // adapter supplies this script name and the actual owner protocol flags.
    await writeFile(
      path.join(directory, "package.json"),
      '{"type":"commonjs"}',
    );
    await writeFile(
      path.join(directory, "cantrip-runtime-owner"),
      `
const fs = require("node:fs");
const args = process.argv.slice(2);
const generation = args[args.indexOf("--generation") + 1];
const event = name => fs.appendFileSync(process.env.CANTRIP_OWNER_LIFETIME_TRACE,
  JSON.stringify({ name, pid: process.pid, parent: process.ppid }) + String.fromCharCode(10));
const ack = JSON.stringify({ version: 1, generation, ready: true }) + String.fromCharCode(10);
if (args.includes("--prepare")) process.stdout.write(ack, () => process.exit(0));
else {
  event("keeper-started");
  process.stdout.write(ack);
  process.stdin.resume();
  process.stdin.on("end", () => {
    event("keeper-stdin-ended");
    setTimeout(() => { event("keeper-settled"); process.exit(0); }, 250);
  });
}
`,
    );
    await writeFile(
      driver,
      `
void (async () => {
const { LocalNativeInferenceOwnership } = await import(process.argv[2]);
const startupReference = setInterval(() => {}, 1000);
const owner = new LocalNativeInferenceOwnership(process.execPath, process.argv[3], {
  serverId: "fixture-server", ownerId: "fixture-owner", workerId: "fixture-worker",
  workerGeneration: "fixture-generation",
}, error => console.error(error));
try { await owner.prepare("fixture-runtime"); }
finally { clearInterval(startupReference); }
console.log(JSON.stringify({ name: "owner-prepared", pid: process.pid }));
await owner.close();
console.log(JSON.stringify({ name: "owner-close-completed", pid: process.pid }));
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
    );
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        driver,
        new URL("../src/native-inference-ownership.ts", import.meta.url).href,
        directory,
      ],
      {
        cwd: directory,
        env: { ...process.env, CANTRIP_OWNER_LIFETIME_TRACE: trace },
        timeout: 10_000,
      },
    );
    expect(stderr).toBe("");
    const stages = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { name: string; pid: number });
    expect(stages.map((stage) => stage.name)).toEqual([
      "owner-prepared",
      "owner-close-completed",
    ]);
    const events = (await readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { name: string; parent: number });
    expect(events.map((event) => event.name)).toEqual([
      "keeper-started",
      "keeper-stdin-ended",
      "keeper-settled",
    ]);
    expect(events.every((event) => event.parent === stages[0].pid)).toBe(true);
  } finally {
    // Also let the deliberately delayed fixture settle if the regression
    // makes the driver exit before its close promise completes.
    await delay(400);
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
