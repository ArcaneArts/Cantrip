// Expectations execute the existing public protocol functions, including their
// binary buffers, UTF-8 replacement and stateful chunk assembler.
import * as p from "../../packages/protocol/dist/worker-link.js";
import { workerLinkWireFixtures } from "./worker-link-wire-fixtures.mjs";
import { createHash } from "node:crypto";
const headers = workerLinkWireFixtures.workerLinkFrameHeaderSchema;
const bytes = (n) => Uint8Array.from({ length: n }, (_, i) => i % 256);
const b64 = (v) => Buffer.from(v).toString("base64");
const outcome = (fn) => {
  try {
    return { ok: fn() };
  } catch (error) {
    return { error: error.message };
  }
};
const details = (frame) => ({
  header: frame.header,
  bytes: b64(frame.bytes),
  payload: b64(frame.payload),
});
const cases = [];
for (const mailbox of [false, true])
  for (const count of [5, 6]) {
    const root = mailbox
      ? "workerLinkPeerMailboxSchema"
      : "workerLinkPeerSignalBatchSchema";
    const template =
      workerLinkWireFixtures.workerLinkPeerSignalEnvelopeSchema[0];
    const signals = Array.from({ length: count }, (_, signalSequence) => ({
      ...template,
      signalSequence,
      signal: { type: "offer", sdp: "🦀".repeat(200000) },
    }));
    const input = mailbox
      ? { ...workerLinkWireFixtures.workerLinkPeerMailboxSchema[0], signals }
      : { signals };
    const result = p[root].safeParse(input);
    const expected = result.success
      ? {
          accepted: true,
          sha256: createHash("sha256")
            .update(JSON.stringify(result.data))
            .digest("hex"),
        }
      : {
          accepted: false,
          issues: result.error.issues,
          errorMessage: result.error.message,
        };
    cases.push({
      op: "signaling-limit",
      root,
      mailbox,
      count,
      template,
      mailboxTemplate: workerLinkWireFixtures.workerLinkPeerMailboxSchema[0],
      outcome: expected,
    });
  }
for (const header of headers)
  for (const length of [
    0,
    1,
    257,
    p.WORKER_LINK_MAX_PAYLOAD_BYTES,
    p.WORKER_LINK_MAX_PAYLOAD_BYTES + 1,
  ]) {
    cases.push({
      op: "create",
      header,
      length,
      outcome: outcome(() =>
        details(p.createWorkerLinkFrame(header, bytes(length))),
      ),
    });
  }
const long = structuredClone(headers[0]);
for (const key of Object.keys(long.grant.binding.identity))
  long.grant.binding.identity[key] = "\ud800".repeat(200);
cases.push({
  op: "create",
  header: long,
  length: 0,
  outcome: outcome(() =>
    details(p.createWorkerLinkFrame(long, new Uint8Array())),
  ),
});
const raw = (header, payload = new Uint8Array(), declared = header.length) => {
  const b = Buffer.alloc(8 + header.length + payload.length);
  b.write("CWLK");
  b.writeUInt32BE(declared, 4);
  Buffer.from(header).copy(b, 8);
  Buffer.from(payload).copy(b, 8 + header.length);
  return b;
};
const decode = (buffer) =>
  cases.push({
    op: "decode",
    bytes: b64(buffer),
    isFrame: p.isWorkerLinkFrame(buffer),
    outcome: outcome(() => details(p.decodeWorkerLinkFrame(buffer))),
  });
for (let n = 0; n < 8; n++) {
  decode(Buffer.alloc(n));
  decode(Buffer.from("CWLKxxxx").subarray(0, n));
}
for (const n of [0, 1, 8192, 8193, 0xffffffff])
  decode(raw(Buffer.from("{}"), new Uint8Array(), n));
for (const text of ["", "{", "null", "[]", "{}", JSON.stringify(headers[1])])
  decode(raw(Buffer.from(text)));
for (const header of headers) {
  const encoded = p.encodeWorkerLinkFrame(
    header,
    header.kind === "data" ? bytes(257) : new Uint8Array(),
  );
  decode(encoded);
}
decode(
  raw(
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(JSON.stringify(headers[1])),
    ]),
  ),
);
decode(raw(Buffer.from(JSON.stringify(headers[1]).padEnd(8192, " "))));
const encoded = Buffer.from(JSON.stringify(headers[0]));
const at = encoded.indexOf(Buffer.from('"fixture"'));
decode(
  raw(
    Buffer.concat([
      encoded.subarray(0, at + 1),
      Buffer.from([0xed, 0xa0, 0x80]),
      encoded.subarray(at + 8),
    ]),
  ),
);
decode(raw(Buffer.from(JSON.stringify(headers[1])), bytes(1)));
decode(raw(Buffer.from(JSON.stringify(headers[3]))));
decode(
  raw(
    Buffer.from(JSON.stringify(headers[3])),
    bytes(p.WORKER_LINK_MAX_PAYLOAD_BYTES + 1),
  ),
);

const chunk = (frameId = 1, frameLength = 4, offset = 0, length = 2) => ({
  frameId,
  frameLength,
  offset,
  payload: bytes(length),
});
const chunks = [
  chunk(),
  chunk(0xffffffff),
  chunk(0x100000000),
  chunk(1, 0),
  chunk(1, p.WORKER_LINK_REMOTE_SURFACE_MAX_FRAME_BYTES + 1),
  chunk(1, 4, 4),
  chunk(1, 4, 3, 2),
  chunk(1, 4, 0, 0),
  chunk(1, 100000, 0, p.WORKER_LINK_REMOTE_SURFACE_CHUNK_PAYLOAD_BYTES),
  chunk(1, 100000, 0, p.WORKER_LINK_REMOTE_SURFACE_CHUNK_PAYLOAD_BYTES + 1),
];
for (const c of chunks)
  cases.push({
    op: "chunk-create",
    frameId: c.frameId,
    frameLength: c.frameLength,
    offset: c.offset,
    length: c.payload.length,
    outcome: outcome(() => b64(p.encodeWorkerLinkRemoteSurfaceChunk(c))),
  });
const encodedChunk = p.encodeWorkerLinkRemoteSurfaceChunk(chunk());
for (let n = 0; n <= encodedChunk.length; n++) {
  const bytes = encodedChunk.subarray(0, n);
  cases.push({
    op: "chunk-decode",
    bytes: b64(bytes),
    outcome: outcome(() => {
      const c = p.decodeWorkerLinkRemoteSurfaceChunk(bytes);
      return {
        frameId: c.frameId,
        frameLength: c.frameLength,
        offset: c.offset,
        payload: b64(c.payload),
      };
    }),
  });
}
for (const replace of [false, true])
  for (const sequence of [
    [chunk(), chunk(1, 4, 2)],
    [chunk(), chunk(2, 4, 2)],
    [chunk(), chunk(1, 5, 2)],
    [chunk(1, 4, 2)],
    [chunk(), chunk(), chunk(1, 4, 2)],
    [chunk(), null, chunk(1, 4, 2)],
  ]) {
    const assembler = new p.WorkerLinkRemoteSurfaceFrameAssembler(replace);
    cases.push({
      op: "assemble",
      replace,
      chunks: sequence.map((c) =>
        c === null ? null : b64(p.encodeWorkerLinkRemoteSurfaceChunk(c)),
      ),
      outcome: sequence.map((c) =>
        outcome(() => {
          if (c === null) {
            assembler.reset();
            return null;
          }
          const value = assembler.push(p.encodeWorkerLinkRemoteSurfaceChunk(c));
          return value === null ? null : b64(value);
        }),
      ),
    });
  }
console.log(JSON.stringify({ cases }));
