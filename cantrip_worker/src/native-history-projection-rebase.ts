import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  nativeHistoryBatchRejectionSchema,
  nativeHistoryCommitReceiptSchema,
} from "@cantrip/protocol";
import { encryptedPayloadEnvelopeSchema } from "@cantrip/protocol/encryption";
import {
  protectNativeHistoryProjectionRebase,
  openNativeHistoryProjectionRebase,
  type NativeHistoryContentContext,
  type NativeHistoryEncryptionService,
} from "./native-history-content.js";
import {
  readHistoryJson,
  writeImmutableHistoryFile,
} from "./native-history-outbox-files.js";
import {
  historyDigestSchema,
  historySequenceSchema,
  nativeHistoryJournalHash as hash,
} from "./native-history-outbox-record.js";

const headerSchema = z
  .object({
    version: z.literal(1),
    sequence: historySequenceSchema,
    recordId: z.string().uuid(),
    previousDigest: historyDigestSchema.nullable(),
    stageDigest: historyDigestSchema,
    envelope: encryptedPayloadEnvelopeSchema,
    digest: historyDigestSchema,
  })
  .strict();
const payloadSchema = z
  .object({
    rejection: nativeHistoryBatchRejectionSchema,
    acceptedReceipts: z.array(nativeHistoryCommitReceiptSchema),
    replacement: z.json(),
  })
  .strict();
export type NativeHistoryProjectionRebase = {
  header: z.infer<typeof headerSchema>;
  payload: z.infer<typeof payloadSchema>;
};
type Options = {
  directory: string;
  stage: { sequence: number; digest: string };
  context: NativeHistoryContentContext;
  service: NativeHistoryEncryptionService;
  ownerId: string;
  serverId: string;
  signal?: AbortSignal;
};
function assertActive(options: Options) {
  options.signal?.throwIfAborted();
  if (
    options.service.ownerId() !== options.ownerId ||
    options.service.serverIdentity() !== options.serverId
  )
    throw new Error(
      "Native history encryption identity changed during rebase.",
    );
}
const pad = (value: number) => String(value).padStart(16, "0");
const filename = (stage: number, attempt: number) =>
  `${pad(stage)}.${pad(attempt)}.rebase.json`;
const context = (
  options: Options,
  header: { sequence: number; recordId: string; previousDigest: string | null },
) => ({
  ...options.context,
  sequence: header.sequence,
  recordId: header.recordId,
  previousDigest: hash([options.stage.digest, header.previousDigest]),
});

/** A frozen recovery plan precedes outbox replacement. It never rewrites the
 * original stage and its accepted prefix remains independently verifiable. */
export async function readNativeHistoryProjectionRebases(options: Options) {
  assertActive(options);
  const files = (await readdir(options.directory))
    .filter(
      (file) =>
        file.startsWith(`${pad(options.stage.sequence)}.`) &&
        file.endsWith(".rebase.json"),
    )
    .sort();
  const result: NativeHistoryProjectionRebase[] = [];
  for (const file of files) {
    assertActive(options);
    const header = headerSchema.parse(
      await readHistoryJson(path.join(options.directory, file)),
    );
    const { digest, ...unsigned } = header;
    if (
      file !== filename(options.stage.sequence, result.length + 1) ||
      header.sequence !== result.length + 1 ||
      header.stageDigest !== options.stage.digest ||
      header.previousDigest !== (result.at(-1)?.header.digest ?? null) ||
      hash(unsigned) !== digest
    )
      throw new Error(
        "Native history projection rebase chain is missing or conflicting.",
      );
    const payload = payloadSchema.parse(
      JSON.parse(
        await openNativeHistoryProjectionRebase({
          service: options.service,
          context: context(options, header),
          envelope: header.envelope,
        }),
      ),
    );
    result.push({ header, payload });
  }
  assertActive(options);
  return result;
}

export async function appendNativeHistoryProjectionRebase(
  options: Options,
  previous: NativeHistoryProjectionRebase[],
  raw: NativeHistoryProjectionRebase["payload"],
) {
  assertActive(options);
  const payload = payloadSchema.parse(raw);
  const header = {
    version: 1 as const,
    sequence: previous.length + 1,
    recordId: randomUUID(),
    previousDigest: previous.at(-1)?.header.digest ?? null,
    stageDigest: options.stage.digest,
  };
  const unsigned = {
    ...header,
    envelope: await protectNativeHistoryProjectionRebase({
      service: options.service,
      context: context(options, header),
      body: JSON.stringify(payload),
    }),
  };
  const saved = headerSchema.parse({ ...unsigned, digest: hash(unsigned) });
  assertActive(options);
  if (
    !(await writeImmutableHistoryFile(
      path.join(
        options.directory,
        filename(options.stage.sequence, saved.sequence),
      ),
      JSON.stringify(saved),
    ))
  )
    throw new Error(
      "Native history projection rebased concurrently; recover its saved plan.",
    );
}
