// Actual Source and native filesystems, with a clock seam for UTC/age boundaries.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  stat,
  chmod,
  utimes,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";
import { DailyLogArchive } from "../../packages/logging/dist/archive.js";
import { NodeDailyLogArchiveStorage } from "../../packages/logging/dist/node.js";

const { values } = parseArgs({
  options: { report: { type: "string" }, binary: { type: "string" } },
});
const root = await mkdtemp(path.join(tmpdir(), "cantrip-log-archive-"));
console.error(JSON.stringify({ event: "log-archive.created", root }));
const report = {
  root,
  scenarios: [],
  scope:
    "Actual filesystem archive; injected clock, explicit maintenance and captured boundary scheduling. Gzip payloads are compared after decompression.",
};
const child = spawn(values.binary, [], { stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (data) => {
  stderr += data;
});
const exited = new Promise((resolve) =>
  child.once("close", (code, signal) => resolve({ code, signal })),
);
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
async function native(message) {
  child.stdin.write(JSON.stringify(message) + "\n");
  const line = await lines.next();
  assert.ok(!line.done, stderr);
  return JSON.parse(line.value);
}
const base = Date.now() + 1000,
  day = (at) => new Date(at).toISOString().slice(0, 10),
  age = 48 * 60 * 60 * 1000;
const managed = (date, part = 1, suffix = "") =>
  `server-${day(date)}.part-${String(part).padStart(4, "0")}.jsonl${suffix}`;
let failure;
try {
  for (const name of [
    "rotation",
    "quota",
    "compression",
    "temporary",
    "legacy",
    "restart",
    "directory-recovery",
    "append-recovery",
    "compression-recovery",
    "permissions",
    "utf16-bytes",
    "leap-year-schedule",
  ]) {
    const directories = [
      path.join(root, name, "node"),
      path.join(root, name, "rust"),
    ];
    for (const directory of directories)
      await mkdir(directory, { recursive: true, mode: 0o755 });
    let now = base,
      diagnostics = [],
      scheduled = [],
      timer;
    const options = {
      source: "server",
      legacyFileNames: ["server.jsonl", "server.service.jsonl"],
      partBytes: 160,
      maxBytes: 5000,
      compressionAgeMs: age,
    };
    if (name === "quota") options.maxBytes = 220;
    if (name === "compression") now = base + age + 10000;
    if (name === "leap-year-schedule")
      now = Date.parse("0000-02-29T12:34:56.000Z");
    const source = () =>
      new DailyLogArchive({
        ...options,
        now: () => new Date(now),
        storage: new NodeDailyLogArchiveStorage(directories[0]),
        onDiagnostic: ({ operation }) => diagnostics.push(operation),
        schedule: (_callback, delay) => {
          scheduled.push(delay);
          timer = {};
          return timer;
        },
        unschedule: () => {
          timer = undefined;
        },
      });
    let node = source();
    const open = () =>
      native({
        op: "open",
        directory: directories[1],
        now,
        source: options.source,
        legacy: options.legacyFileNames,
        partBytes: options.partBytes,
        maxBytes: options.maxBytes,
        compressionAgeMs: options.compressionAgeMs,
      });
    assert.equal((await open()).ok, true);
    const result = { name, steps: [] };
    report.scenarios.push(result);
    async function seed(filename, contents, mode = 0o600) {
      for (const directory of directories)
        await writeFile(path.join(directory, filename), contents, { mode });
    }
    async function snapshot(directory) {
      const entries = [];
      for (const entry of (
        await readdir(directory, { withFileTypes: true })
      ).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile()) continue;
        const filename = entry.name,
          metadata = await stat(path.join(directory, filename));
        const bytes = await readFile(path.join(directory, filename));
        entries.push({
          name: filename,
          contents: (filename.endsWith(".gz")
            ? gunzipSync(bytes)
            : bytes
          ).toString("base64"),
          mode: process.platform === "win32" ? null : metadata.mode & 0o777,
        });
      }
      return entries;
    }
    async function step(op, record) {
      const previous = diagnostics.length,
        previousSchedules = scheduled.length;
      if (op === "append") await node.append(record);
      else await node[op]();
      const actual = await native({ op, record, now });
      assert.equal(
        actual.ok,
        diagnostics.length === previous,
        `${name}/${op}: ${actual.error}`,
      );
      assert.equal(
        actual.scheduledDelayMs,
        scheduled.length > previousSchedules ? scheduled.at(-1) : null,
        `${name}/${op}: boundary`,
      );
      const snapshots = await Promise.all(directories.map(snapshot));
      assert.deepEqual(
        snapshots[1],
        snapshots[0],
        `${name}/${op}: actual files`,
      );
      result.steps.push({
        op,
        ok: actual.ok,
        diagnostics: diagnostics.slice(previous),
        files: snapshots[0].map((entry) => entry.name),
        scheduledDelayMs: actual.scheduledDelayMs,
      });
    }
    if (name === "compression") {
      await seed(managed(base - 86400000), '{"old":true}\n');
      await seed(managed(base - 86400000, 2), '{"duplicate":true}\n');
      await seed(
        managed(base - 86400000, 2, ".gz"),
        gzipSync('{"completed":true}\n'),
      );
      await seed("worker-2020-01-01.part-0001.jsonl", "foreign");
    }
    if (name === "temporary") {
      await seed(managed(base, 1), "plain\n");
      await seed(managed(base, 1, ".gz.tmp"), "partial");
      await seed(managed(base, 2, ".gz"), gzipSync("completed\n"));
      await seed(managed(base, 2, ".gz.tmp"), "partial");
      await seed(managed(base, 3, ".gz.tmp"), "orphan");
      await seed("worker-2020-01-01.part-0001.jsonl.gz.tmp", "foreign");
      for (const directory of directories)
        await symlink("missing", path.join(directory, "ignored-symlink"));
    }
    if (name === "legacy") {
      for (const [index, filename] of [
        "server.jsonl.3",
        "server.jsonl.2",
        "server.service.jsonl",
        "server.jsonl",
        "server.jsonl.4",
      ].entries()) {
        await seed(filename, `${filename}\n`);
        for (const directory of directories)
          await utimes(
            path.join(directory, filename),
            new Date(base - index * 10000),
            new Date(base - index * 10000),
          );
      }
      await seed(managed(base, 5), "existing\n");
    }
    if (name === "directory-recovery")
      for (const directory of directories) {
        await rm(directory, { recursive: true });
        await writeFile(directory, "obstruction");
      }
    if (name === "compression-recovery") {
      now = base + age + 10000;
      await seed(managed(base - 86400000), "old\n");
      for (const directory of directories)
        await mkdir(
          path.join(directory, managed(base - 86400000, 1, ".gz.tmp")),
        );
    }
    if (name === "permissions") await seed(managed(base), "existing\n", 0o644);
    if (name === "directory-recovery") {
      const before = diagnostics.length;
      await node.initialize();
      const actual = await native({ op: "initialize", now });
      assert.equal(actual.ok, false);
      assert.equal(diagnostics.length, before + 1);
      result.steps.push({ op: "initialize", ok: false, actualIoFailure: true });
      for (const directory of directories) await rm(directory);
    } else await step("initialize");
    if (name === "compression-recovery")
      for (const directory of directories)
        await rm(path.join(directory, managed(base - 86400000, 1, ".gz.tmp")), {
          recursive: true,
        });
    if (name === "append-recovery") {
      for (const directory of directories) {
        await rename(directory, directory + ".saved");
        await writeFile(directory, "obstruction");
      }
      const before = diagnostics.length;
      await node.append({ failure: "write" });
      const actual = await native({
        op: "append",
        now,
        record: { failure: "write" },
      });
      assert.equal(actual.ok, false);
      assert.equal(diagnostics.length, before + 1);
      result.steps.push({ op: "append", ok: false, actualIoFailure: true });
      for (const directory of directories) {
        await rm(directory);
        await rename(directory + ".saved", directory);
      }
    }
    for (let index = 0; index < 8; index++)
      await step("append", {
        index,
        message: (name === "utf16-bytes" ? "🦀é\ud800" : "a").repeat(index * 7),
        nullable: null,
      });
    if (name === "restart") {
      await step("close");
      node = source();
      assert.equal((await open()).ok, true);
      await step("initialize");
      await step("append", { restarted: true });
    }
    now += 86400000;
    await step("maintain");
    await step("append", { nextDay: true });
    now += age + 10000;
    await step("maintain");
    await step("close");
    assert.equal(timer, undefined);
    await step("append", { afterClose: true });
    for (const directory of directories)
      if (process.platform !== "win32")
        assert.equal((await stat(directory)).mode & 0o777, 0o700);
  }
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  child.stdin.end();
  report.exit = await exited;
  report.stderr = stderr;
  if (values.report)
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
}
if (failure) throw failure;
assert.deepEqual(report.exit, { code: 0, signal: null });
console.log(
  JSON.stringify({
    passed: true,
    root,
    scenarios: report.scenarios.length,
    steps: report.scenarios.reduce((sum, s) => sum + s.steps.length, 0),
  }),
);
