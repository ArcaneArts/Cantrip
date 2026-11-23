#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, open, link, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  LocalDocker,
  captureSystemCheckpoint,
  observeSystemCheckpoint,
  continueSystemCheckpoint,
  openSystemCheckpointImage,
} from "../host/index.mjs";

const [action, requestFile, journalPath, outputPath, ...extra] =
  process.argv.slice(2);
if (
  !requestFile ||
  !journalPath ||
  extra.length ||
  !["capture", "observe", "continue", "export"].includes(action) ||
  (action === "export" ? !outputPath : outputPath !== undefined)
) {
  console.error(
    "Usage: manage-system.mjs capture|observe|continue request.json private-journal.json\n       manage-system.mjs export request.json private-journal.json private-system-image.tar",
  );
  process.exitCode = 1;
} else {
  const input = {
    request: JSON.parse(await readFile(requestFile, "utf8")),
    journalPath,
  };
  const engine = await LocalDocker.current();
  if (action === "export") {
    const temporary = `${outputPath}.${randomUUID()}.partial`;
    const source = await openSystemCheckpointImage(engine, input);
    try {
      const hash = createHash("sha256");
      let bytes = 0;
      const measure = new Transform({
        transform(chunk, encoding, callback) {
          hash.update(chunk);
          bytes += chunk.length;
          callback(null, chunk);
        },
      });
      await pipeline(
        source,
        measure,
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      const file = await open(temporary, "r");
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      await link(temporary, outputPath);
      await unlink(temporary);
      const directory = await open(dirname(outputPath), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      console.log(
        JSON.stringify({
          outputPath,
          bytes,
          sha256: hash.digest("hex"),
          containsPrivateIdentity: true,
          mountedDataIncluded: false,
        }),
      );
    } finally {
      source.destroy();
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  } else {
    const operation = {
      capture: captureSystemCheckpoint,
      observe: observeSystemCheckpoint,
      continue: continueSystemCheckpoint,
    }[action];
    const result = await operation(engine, input);
    console.log(
      JSON.stringify(
        result
          ? {
              operationId: result.operation.request.operationId,
              state: result.operation.state,
              phase: result.operation.phase,
              snapshot: result.operation.snapshot,
              error: result.operation.error,
              lastError: result.operation.lastError,
              originalRunning: result.observation?.State.Running ?? null,
              observationError: result.observationError,
            }
          : null,
        null,
        2,
      ),
    );
  }
}
