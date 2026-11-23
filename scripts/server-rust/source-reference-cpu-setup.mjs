// Opt-in diagnostic only. Save inside the actual worker before Vitest's parent
// terminates its Windows fork, where SIGTERM cannot flush exit-time profiles.
import { afterAll, beforeAll, expect } from "vitest";
import { Session } from "node:inspector";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { threadId } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import path from "node:path";

const directory = fileURLToPath(
  new URL("../../.qa/rust-server/source-reference-cpu/", import.meta.url),
);
const session = new Session();
const post = (method) =>
  new Promise((resolve, reject) =>
    session.post(method, (error, result) =>
      error ? reject(error) : resolve(result),
    ),
  );
let connected = false;
let started = false;
let metadata;

beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  metadata = {
    pid: process.pid,
    threadId,
    testPath: expect.getState().testPath,
    startedAt: new Date().toISOString(),
  };
  session.connect();
  connected = true;
  await post("Profiler.enable");
  await post("Profiler.start");
  started = true;
});

afterAll(async () => {
  try {
    if (!started) return;
    const { profile } = await post("Profiler.stop");
    const file = path
      .basename(metadata.testPath ?? "unknown")
      .replace(/[^a-zA-Z0-9_.-]/g, "_");
    const name = `${file}-${process.pid}-${threadId}-${randomUUID()}`;
    await writeFile(
      path.join(directory, `${name}.cpuprofile`),
      JSON.stringify(profile),
    );
    await writeFile(
      path.join(directory, `${name}.json`),
      JSON.stringify(
        {
          ...metadata,
          completedAt: new Date().toISOString(),
          actualWorkerProfileSaved: true,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    started = false;
    if (connected) session.disconnect();
    connected = false;
  }
});
