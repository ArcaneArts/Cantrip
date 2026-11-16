// Expectations execute the maintained public codec. Large payloads are hashed
// so this focused boundary comparison produces only a small fixture document.
import { createHash } from "node:crypto";
import {
  encodeRemoteSurfaceFrame,
  decodeRemoteSurfaceFrame,
} from "../../packages/protocol/dist/index.js";

const header = {
  protocolVersion: 1,
  surfaceId: "surface",
  attachmentId: "attachment",
  sequence: 0,
  channel: "frame",
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cases = [];
function add(input) {
  let outcome;
  try {
    let bytes;
    if (input.op === "create") {
      bytes = encodeRemoteSurfaceFrame(
        input.header,
        Buffer.alloc(input.payloadLength, 91),
      );
    } else if (input.op === "bytes") {
      bytes = Buffer.from(input.bytes, "base64");
    } else {
      const raw = Buffer.from(input.headerBytes, "base64");
      bytes = Buffer.alloc(8 + raw.length + input.payloadLength, 91);
      bytes.write("CTRS");
      bytes.writeUInt32BE(input.declared ?? raw.length, 4);
      bytes.set(raw, 8);
    }
    const decoded = decodeRemoteSurfaceFrame(bytes);
    outcome = {
      value: {
        header: decoded.header,
        frameHash: hash(bytes),
        payloadHash: hash(decoded.payload),
      },
    };
  } catch (error) {
    outcome = { error: error.message };
  }
  cases.push({ input, outcome });
}
for (const payloadLength of [0, 1, 257, 4 * 1024 * 1024, 4 * 1024 * 1024 + 1])
  add({ op: "create", header, payloadLength });
for (const patch of [
  { surfaceId: "\ud800" },
  { surfaceId: "雪😀" },
  { sequence: Number.MAX_SAFE_INTEGER },
  { sequence: -1 },
  { channel: "unknown" },
  { ignored: true },
])
  add({ op: "create", header: { ...header, ...patch }, payloadLength: 3 });
for (const raw of [
  JSON.stringify(header),
  "\ufeff" + JSON.stringify(header),
  JSON.stringify({ ignored: 1, ...header }),
  JSON.stringify(header).replace('"sequence":0', '"sequence":1,"sequence":2'),
  "{}",
  "null",
  "{",
  Buffer.from('{"surfaceId":"\xff"}', "latin1"),
])
  add({
    op: "raw",
    headerBytes: Buffer.from(raw).toString("base64"),
    payloadLength: 3,
  });
for (const declared of [0, 65537, 1000])
  add({
    op: "raw",
    headerBytes: Buffer.from("{}").toString("base64"),
    declared,
    payloadLength: 0,
  });
add({
  op: "raw",
  headerBytes: Buffer.from(JSON.stringify(header)).toString("base64"),
  payloadLength: 4 * 1024 * 1024 + 1,
});
for (const bytes of [Buffer.alloc(0), Buffer.alloc(7), Buffer.alloc(8)])
  add({ op: "bytes", bytes: bytes.toString("base64") });
console.log(JSON.stringify(cases));
