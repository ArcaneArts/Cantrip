import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  closeServerLogArchive,
  initializeServerLogArchive,
  serverLogger,
} from "../src/logger.js";

describe("server daily log archive", () => {
  let temporaryDirectory: string | null = null;

  afterEach(async () => {
    await closeServerLogArchive();
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { force: true, recursive: true });
      temporaryDirectory = null;
    }
  });

  it("persists minimized records below the server data directory", async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "cantrip-server-log-"),
    );
    await initializeServerLogArchive(temporaryDirectory);
    serverLogger.event("warn", "Provider request failed", {
      event: "provider.request.failed",
      subsystem: "provider",
      status: "failed",
      apiKey: "sk-abcdefghijk",
    });
    await closeServerLogArchive();

    const directory = path.join(temporaryDirectory, "logs");
    const files = await readdir(directory);
    expect(files).toEqual([
      expect.stringMatching(/^server-\d{4}-\d{2}-\d{2}\.part-0001\.jsonl$/u),
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
      system: "server",
    });
    expect(JSON.stringify(record)).not.toContain("sk-abcdefghijk");
  });
});
