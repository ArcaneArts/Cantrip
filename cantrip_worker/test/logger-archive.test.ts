import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureWorkerDiagnostic,
  closeWorkerLogArchive,
  initializeWorkerLogArchive,
} from "../src/logger.js";

describe("worker daily log archive", () => {
  let temporaryDirectory: string | null = null;

  afterEach(async () => {
    await closeWorkerLogArchive();
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { force: true, recursive: true });
      temporaryDirectory = null;
    }
  });

  it("persists minimized records below the worker data directory", async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "cantrip-worker-log-"),
    );
    await initializeWorkerLogArchive(temporaryDirectory);
    captureWorkerDiagnostic("warn", "Provider request failed", {
      event: "provider.request.failed",
      subsystem: "provider",
      status: "failed",
      apiKey: "sk-abcdefghijk",
    });
    await closeWorkerLogArchive();

    const directory = path.join(temporaryDirectory, "logs");
    const files = await readdir(directory);
    expect(files).toEqual([
      expect.stringMatching(/^worker-\d{4}-\d{2}-\d{2}\.part-0001\.jsonl$/u),
    ]);
    const record = JSON.parse(
      await readFile(path.join(directory, files[0]!), "utf8"),
    );
    expect(record).toMatchObject({
      context: {
        event: "provider.request.failed",
        status: "failed",
        subsystem: "provider",
      },
      level: "warn",
      message: "provider.request.failed",
      system: "worker",
    });
    expect(JSON.stringify(record)).not.toContain("sk-abcdefghijk");
  });
});
