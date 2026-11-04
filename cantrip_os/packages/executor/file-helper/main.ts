import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename, open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { explorerOperationRequestContentSchema } from "@cantrip/protocol/surface-stream";
import {
  executeExplorerRequest,
  explorerRequestFailure,
  explorerRequestMutates,
} from "../../../../cantrip_worker/src/commands/explorer-request.js";
import { BinaryFileWrites } from "../../../../cantrip_worker/src/binary-file-writes.js";
import { ExplorerFileImports } from "../../../../cantrip_worker/src/explorer-file-imports.js";

// This is an authenticated executor child, not a network service or worker.
// Its root and cache identity are fixed by the worker's captured placement.
process.umask(0o077);
const [root, identity] = process.argv.slice(2);
if (!root?.startsWith("/") || !identity || !/^[a-f0-9]{64}$/.test(identity))
  throw new Error("Expected a captured Linux root and identity.");
const directory = path.join(
  process.argv[4] ?? homedir(),
  ".local/state/cantrip-os-executor/files",
  identity,
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const keyFile = path.join(directory, "cache-key");
try {
  await writeFile(keyFile, randomBytes(32), { flag: "wx", mode: 0o600 });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
}
const key = await readFile(keyFile);
if (key.length !== 32) throw new Error("Invalid local file cache key.");
// Only this locally generated staging key is in the guest. Account encryption
// and provider credentials remain on the owning worker.
const fileImports = new ExplorerFileImports();
const binaryWrites = new BinaryFileWrites(directory, {
  ownerId: () => identity,
  componentKey: () => ({ key: new Uint8Array(key), keyRevision: 1 }),
});
async function durableJson(
  filename: string,
  value: unknown,
  exclusive = false,
) {
  const target = exclusive ? filename : filename + ".tmp";
  const file = await open(target, exclusive ? "wx" : "w", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  if (!exclusive) await rename(target, filename);
  const parent = await open(path.dirname(filename), "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
const frame = z
  .object({
    id: z.uuid(),
    action: z.enum(["execute", "observe"]).default("execute"),
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    request: explorerOperationRequestContentSchema.optional(),
    context: z
      .object({
        serverId: z.string().min(1),
        surfaceKind: z.enum(["explorer", "file-document"]),
        surfaceId: z.string().min(1),
        operationId: z.uuid(),
        sequence: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
const emit = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
emit({ ready: true, version: 1, identity });
try {
  for await (const line of lines) {
    const message = frame.parse(JSON.parse(line));
    if (
      message.action === "execute" &&
      message.request &&
      !explorerRequestMutates(message.request)
    ) {
      let result;
      try {
        result = await executeExplorerRequest(
          root,
          message.request,
          { fileImports, binaryWrites },
          message.context,
        );
      } catch (error) {
        result = explorerRequestFailure(error);
      }
      emit({ id: message.id, result });
      continue;
    }
    const digest =
      message.action === "observe"
        ? message.digest!
        : createHash("sha256")
            .update(
              JSON.stringify({
                id: message.id,
                request: message.request,
                context: message.context,
              }),
            )
            .digest("hex");
    const filename = path.join(
      directory,
      createHash("sha256")
        .update(JSON.stringify(message.context))
        .digest("hex") + ".json",
    );
    let saved: { digest: string; result?: unknown } | undefined;
    try {
      saved = JSON.parse(await readFile(filename, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (saved) {
      emit({
        id: message.id,
        result:
          saved.digest !== digest
            ? explorerRequestFailure(
                new Error(
                  "OS file operation identity was reused with different input.",
                ),
              )
            : (saved.result ??
              explorerRequestFailure(
                new Error(
                  "The OS file operation has an unknown outcome. Inspect the file before issuing another mutation.",
                ),
              )),
      });
      continue;
    }
    if (message.action === "observe" || !message.request || !digest) {
      emit({
        id: message.id,
        result: explorerRequestFailure(
          new Error(
            "The OS file operation has no saved completion. Its outcome is unknown; it was not replayed.",
          ),
        ),
      });
      continue;
    }
    await durableJson(filename, { digest }, true);
    let result;
    try {
      result = await executeExplorerRequest(
        root,
        message.request,
        { fileImports, binaryWrites },
        message.context,
      );
    } catch (error) {
      result = explorerRequestFailure(error);
    }
    await durableJson(filename, { digest, result });
    emit({ id: message.id, result });
  }
} finally {
  await fileImports.dispose();
  await binaryWrites.dispose();
  key.fill(0);
}
