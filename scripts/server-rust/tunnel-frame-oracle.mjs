// Expected bytes and failures execute the real codec, never the Rust manifest.
import {
  encodeTunnelDataPlaneFrame,
  decodeTunnelDataPlaneFrame,
} from "../../packages/protocol/dist/index.js";
import { tunnelRecord } from "./tunnel-record-fixture.mjs";
const base = {
  protocolVersion: 1,
  tunnelId: "tunnel",
  attachmentId: "attachment",
  sourceEndpointId: "desktop:client:attachment",
  destinationEndpointId: "worker:alpha",
  connectionId: "connection",
  sequence: 0,
};
const samples = [
  { kind: "open", initialCreditBytes: 1024 },
  {
    kind: "connect",
    initialCreditBytes: 1024,
    target: {
      kind: "protected-tunnel",
      targetKind: "tcp",
      recordId: "tunnel",
      protectedRecord: tunnelRecord,
    },
  },
  { kind: "accepted", initialCreditBytes: 1024 },
  { kind: "rejected", code: "target-rejected" },
  { kind: "data", direction: "source-to-destination" },
  {
    kind: "data",
    direction: "destination-to-source",
    protection: {
      formatVersion: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: "AAAAAAAAAAAAAAAA",
    },
  },
  { kind: "credit", direction: "destination-to-source", bytes: 1048576 },
  { kind: "half-close", direction: "source-to-destination" },
  { kind: "close", code: "normal" },
  { kind: "error", code: "io-error" },
].map((v) => ({ ...base, ...v }));
const cases = [];
function observe(input) {
  try {
    const bytes =
      input.op === "create"
        ? encodeTunnelDataPlaneFrame(
            input.header,
            Buffer.alloc(input.payloadLength ?? 0, 91),
          )
        : Buffer.from(input.frame, "base64");
    const decoded = decodeTunnelDataPlaneFrame(bytes);
    return {
      value: {
        header: decoded.header,
        payload: Buffer.from(decoded.payload).toString("base64"),
        frame: Buffer.from(bytes).toString("base64"),
      },
    };
  } catch (error) {
    return { error: error.message };
  }
}
const add = (input) => cases.push({ input, outcome: observe(input) });
for (const header of samples)
  for (const payloadLength of [
    0, 1, 15, 16, 17, 65535, 65536, 65537, 65552, 65553,
  ])
    add({ op: "create", header, payloadLength });
for (const value of [
  " \ud800 ",
  "\u00a0identifier\u00a0",
  "😀".repeat(100),
  "é".repeat(200),
  "nul\u0000id",
  "",
  false,
  null,
  {},
  9007199254740992,
]) {
  for (const key of ["tunnelId", "sequence", "initialCreditBytes"])
    add({ op: "create", header: { ...samples[0], [key]: value } });
}
for (const size of [7900, 8100, 8200]) {
  const header = structuredClone(samples[1]);
  header.target.protectedRecord.protectedContent.envelope.ciphertext =
    "A".repeat(size);
  add({ op: "create", header });
}
function raw(
  header,
  payload = Buffer.alloc(0),
  length = header.length,
  magic = "CTTN",
) {
  const bytes = Buffer.alloc(8 + header.length + payload.length);
  bytes.write(magic, 0);
  bytes.writeUInt32BE(length, 4);
  header.copy(bytes, 8);
  payload.copy(bytes, 8 + header.length);
  add({ op: "decode", frame: bytes.toString("base64") });
}
const encoded = Buffer.from(JSON.stringify(samples[0]));
for (const text of [
  "",
  "[",
  "null",
  "{}",
  JSON.stringify(samples[0]),
  JSON.stringify({ ...samples[0], tunnelId: " \ud800 " }),
  JSON.stringify({ ...samples[0], extra: { deep: [1] } }),
])
  raw(Buffer.from(text));
raw(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encoded]));
raw(
  Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), encoded]),
);
raw(
  Buffer.from(
    JSON.stringify(samples[0]).replace(
      '"tunnelId":"tunnel"',
      '"tunnelId":"a\u0080b"',
    ),
  ).map((v) => (v === 0xc2 ? 0xff : v)),
);
raw(
  Buffer.from(
    JSON.stringify(samples[0]).replace(
      '"kind":"open"',
      '"kind":"data","kind":"open"',
    ),
  ),
);
raw(
  Buffer.from(
    JSON.stringify(samples[0]).replace('"sequence":0', '"sequence":1e400'),
  ),
);
raw(
  Buffer.from(
    JSON.stringify(samples[0]).replace(
      '"initialCreditBytes":1024',
      '"initialCreditBytes":-0',
    ),
  ),
);
for (const count of [1, 8191, 8192, 8193])
  raw(
    count < encoded.length
      ? encoded
      : Buffer.concat([encoded, Buffer.alloc(count - encoded.length, 32)]),
    Buffer.alloc(0),
    count,
  );
raw(encoded, Buffer.alloc(0), 0);
raw(encoded, Buffer.alloc(0), encoded.length + 1);
raw(encoded, Buffer.alloc(0), encoded.length, "FAIL");
for (const bytes of [
  Buffer.alloc(0),
  Buffer.from("CTTN"),
  Buffer.from("CTTN000"),
])
  add({ op: "decode", frame: bytes.toString("base64") });
const maximumDepth = Math.floor(
  (8192 -
    Buffer.byteLength(
      JSON.stringify(samples[0]).slice(0, -1) + ',"extra":0}',
    )) /
    2,
);
for (const depth of [129, 512, 2000, maximumDepth]) {
  const text =
    JSON.stringify(samples[0]).slice(0, -1) +
    ',"extra":' +
    "[".repeat(depth) +
    "0" +
    "]".repeat(depth) +
    "}";
  raw(Buffer.from(text));
}
console.log(JSON.stringify({ cases }));
