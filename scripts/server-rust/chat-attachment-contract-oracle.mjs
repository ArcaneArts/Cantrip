// Expectations execute the unchanged protocol schemas and real refinements.
import * as p from "../../packages/protocol/dist/index.js";
import { vectorCases, outcome } from "./security-oracle.mjs";
import {
  protectedAttachmentMetadataFixture,
  protectedAttachmentChunkFixture,
} from "../../tests/reference-node-server/test/protected-attachment-fixture.ts";
const metadata = protectedAttachmentMetadataFixture();
const chunk = protectedAttachmentChunkFixture({
  sequence: 0,
  plaintextBytes: 3,
  eof: true,
});
const upload = {
  attachmentId: "44444444-4444-4444-8444-000000000001",
  operationId: "33333333-3333-4333-8333-000000000001",
  sizeBytes: 3,
  protectedMetadata: metadata,
  chunks: [chunk],
};
const samples = {
  attachmentUploadOpaqueSchema: [upload],
  attachmentDownloadOpaqueSchema: [upload],
  attachmentProtectedMetadataSchema: [metadata],
  attachmentChunkOpaqueSchema: [chunk],
  chatAttachmentOpaqueSummarySchema: [
    {
      id: upload.attachmentId,
      chatId: "chat",
      sizeBytes: 3,
      status: "ready",
      protectedMetadata: metadata,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  workerAttachmentUploadResultSchema: [{ sizeBytes: 3, verified: true }],
  workerAttachmentReadResultSchema: [{ sizeBytes: 3, chunk }],
};
const name = process.argv[2];
const cases = [...vectorCases(name, samples[name])];
function add(input) {
  const result = outcome(p[name], input);
  cases.push({
    input,
    outcome: result,
    ...(result.issues
      ? { errorMessage: p[name].safeParse(input).error.message }
      : {}),
  });
}
if (
  name === "attachmentUploadOpaqueSchema" ||
  name === "attachmentDownloadOpaqueSchema"
) {
  for (const length of [0, 1, 2, 100, 101, 102]) {
    const chunks = Array.from({ length }, (_, sequence) =>
      protectedAttachmentChunkFixture({
        sequence,
        plaintextBytes: 1,
        eof: sequence === length - 1,
      }),
    );
    add({ ...upload, sizeBytes: length, chunks });
    add({ ...upload, sizeBytes: 0, chunks });
    if (length) {
      add({
        ...upload,
        sizeBytes: length,
        chunks: chunks.map((c) => ({ ...c, eof: false })),
      });
      add({
        ...upload,
        sizeBytes: length,
        chunks: chunks.map((c) => ({ ...c, sequence: 99, eof: true })),
      });
    }
  }
  for (const sizeBytes of [
    -1,
    0,
    3,
    26214400,
    26214401,
    Number.MAX_SAFE_INTEGER,
  ])
    add({ ...upload, sizeBytes });
  for (const sequence of [
    0,
    -1,
    1,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    add({ ...upload, chunks: [{ ...chunk, sequence }] });
  const mismatched = structuredClone(upload);
  mismatched.protectedMetadata.envelope.keyRevision = 2;
  add(mismatched);
  const invalid = structuredClone(upload);
  invalid.chunks[0].plaintextBytes = "invalid";
  invalid.chunks[0].eof = false;
  add(invalid);
  add({
    ...upload,
    chunks: [
      { ...chunk, plaintextBytes: 0, eof: false },
      { ...chunk, sequence: 1 },
    ],
  });
}
if (name === "attachmentProtectedMetadataSchema") {
  const copy = structuredClone(metadata);
  copy.envelope.keyRevision = 2;
  add(copy);
}
console.log(JSON.stringify({ cases }));
