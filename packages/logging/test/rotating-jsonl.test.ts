import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RotatingJsonlLog } from "../src/index.js";

describe("rotating JSONL logs", () => {
  it("rotates bounded files without dropping the triggering record", () => {
    const directory = mkdtempSync(join(tmpdir(), "cantrip-log-"));
    const filePath = join(directory, "worker.jsonl");
    const log = new RotatingJsonlLog({ filePath, maxBytes: 220, maxFiles: 2 });
    for (let cursor = 1; cursor <= 5; cursor += 1) {
      log.write({
        cursor,
        timestamp: "2026-08-16T12:00:00.000Z",
        system: "worker",
        level: "info",
        message: `record-${cursor}`,
      });
    }
    log.close();

    const current = readFileSync(filePath, "utf8");
    const previous = readFileSync(`${filePath}.1`, "utf8");
    expect(current).toContain('"cursor":5');
    expect(previous).toContain('"cursor":3');
    expect(previous).toContain('"cursor":4');
  });
});
