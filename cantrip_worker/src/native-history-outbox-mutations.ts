import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { nativeHistoryBatchRejectionSchema } from "@cantrip/protocol";
import { encryptedPayloadEnvelopeSchema } from "@cantrip/protocol/encryption";
import {
  openNativeHistoryOutboxMutation,
  protectNativeHistoryOutboxMutation,
  type NativeHistoryEncryptionService,
} from "./native-history-content.js";
import {
  readHistoryJson,
  writeImmutableHistoryFile,
} from "./native-history-outbox-files.js";
import {
  historyDigestSchema,
  historySequenceSchema,
  nativeHistoryOutboxRecordSchema,
  nativeHistoryJournalHash as hash,
} from "./native-history-outbox-record.js";

const headerSchema = z
  .object({
    version: z.literal(1),
    sequence: historySequenceSchema,
    recordId: z.string().uuid(),
    previousDigest: historyDigestSchema.nullable(),
    legacyCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    legacyDigest: historyDigestSchema.nullable(),
    envelope: encryptedPayloadEnvelopeSchema,
    digest: historyDigestSchema,
  })
  .strict();
const payloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("append"),
      record: nativeHistoryOutboxRecordSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("replace"),
      rejection: nativeHistoryBatchRejectionSchema,
      records: z.array(nativeHistoryOutboxRecordSchema).min(1),
    })
    .strict(),
]);
type Options = {
  directory: string;
  streamId: string;
  service: NativeHistoryEncryptionService;
  scope: {
    ownerId: string;
    serverId: string;
    workerId: string;
    chatId: string;
    bindingId: string;
  };
  legacyCount: number;
  legacyDigest: string | null;
};
export type NativeHistoryOutboxMutation = {
  header: z.infer<typeof headerSchema>;
  payload: z.infer<typeof payloadSchema>;
};
const filename = (sequence: number) =>
  `${String(sequence).padStart(16, "0")}.mutation.json`;
const context = (
  options: Options,
  header: {
    sequence: number;
    recordId: string;
    previousDigest: string | null;
    legacyCount: number;
    legacyDigest: string | null;
  },
) => ({
  ...options.scope,
  streamId: options.streamId,
  sequence: header.sequence,
  recordId: header.recordId,
  previousDigest: hash([
    header.previousDigest,
    header.legacyCount,
    header.legacyDigest,
  ]),
});

function assertIdentity(options: Options) {
  if (
    options.service.ownerId() !== options.scope.ownerId ||
    options.service.serverIdentity() !== options.scope.serverId
  )
    throw new Error(
      "Native history encryption identity changed during mutation.",
    );
}

/** Both appends and repairs compete for one immutable next slot, including
 * across processes. Legacy batch files become a fixed prefix, never rewritten. */
export async function readNativeHistoryOutboxMutations(options: Options) {
  assertIdentity(options);
  const files = (await readdir(options.directory))
    .filter((name) => name.endsWith(".mutation.json"))
    .sort();
  const result: NativeHistoryOutboxMutation[] = [];
  for (const file of files) {
    const header = headerSchema.parse(
      await readHistoryJson(path.join(options.directory, file)),
    );
    const { digest, ...unsigned } = header;
    if (
      file !== filename(result.length + 1) ||
      header.sequence !== result.length + 1 ||
      header.previousDigest !== (result.at(-1)?.header.digest ?? null) ||
      header.legacyCount !== options.legacyCount ||
      header.legacyDigest !== options.legacyDigest ||
      hash(unsigned) !== digest
    )
      throw new Error(
        "Native history mutation log has a missing or conflicting record.",
      );
    const payload = payloadSchema.parse(
      JSON.parse(
        await openNativeHistoryOutboxMutation({
          service: options.service,
          context: context(options, header),
          envelope: header.envelope,
        }),
      ),
    );
    result.push({ header, payload });
  }
  assertIdentity(options);
  return result;
}

export async function appendNativeHistoryOutboxMutation(
  options: Options,
  mutations: NativeHistoryOutboxMutation[],
  raw: NativeHistoryOutboxMutation["payload"],
) {
  assertIdentity(options);
  const payload = payloadSchema.parse(raw);
  const fields = {
    version: 1 as const,
    sequence: historySequenceSchema.parse(mutations.length + 1),
    recordId: randomUUID(),
    previousDigest: mutations.at(-1)?.header.digest ?? null,
    legacyCount: options.legacyCount,
    legacyDigest: options.legacyDigest,
  };
  const unsigned = {
    ...fields,
    envelope: await protectNativeHistoryOutboxMutation({
      service: options.service,
      context: context(options, fields),
      body: JSON.stringify(payload),
    }),
  };
  const header = headerSchema.parse({ ...unsigned, digest: hash(unsigned) });
  assertIdentity(options);
  if (
    !(await writeImmutableHistoryFile(
      path.join(options.directory, filename(header.sequence)),
      JSON.stringify(header),
    ))
  )
    throw new Error(
      "Native history journal advanced concurrently; retry the same record.",
    );
}
