import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { parse } from "@babel/parser";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const sourceIndex = process.argv.indexOf("--source");
const source = await readFile(
  sourceIndex < 0
    ? path.join(root, "cantrip_app/src/lib/browser-code-tunnel.ts")
    : process.argv[sourceIndex + 1],
  "utf8",
);
const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
const names = ["dechunk", "findBytes", "parseHttpResponse"];
const declarations = names.map((name) => {
  const node = tree.program.body.find(
    (node) => node.type === "FunctionDeclaration" && node.id?.name === name,
  );
  assert.ok(node, `Actual production function ${name} must be present`);
  return source.slice(node.start, node.end);
});
let allocatedBytes = 0;
class CountedBytes extends Uint8Array {
  constructor(value, ...rest) {
    super(value, ...rest);
    // Count new owned byte storage, not a view over existing storage.
    if (!(value instanceof ArrayBuffer)) allocatedBytes += this.byteLength;
  }
}
const context = {
  Uint8Array: CountedBytes,
  textEncoder: new TextEncoder(),
  textDecoder: new TextDecoder(),
};
vm.runInNewContext(
  stripTypeScriptTypes(
    `${declarations.join("\n")}\nglobalThis.parseResponse = parseHttpResponse;`,
  ),
  context,
);
const encoder = new TextEncoder();
const concatenate = (chunks) => {
  const result = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};
function workload(size, chunked) {
  const body = new Uint8Array(size);
  for (let index = 0; index < size; index++) body[index] = index % 251;
  const head = encoder.encode(
    `HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n${chunked ? "Transfer-Encoding: chunked" : `Content-Length: ${size}`}\r\n\r\n`,
  );
  const chunks = [head];
  if (chunked) {
    for (let offset = 0; offset < size; offset += 64 * 1024) {
      const chunk = body.subarray(offset, Math.min(size, offset + 64 * 1024));
      chunks.push(
        encoder.encode(`${chunk.length.toString(16)}\r\n`),
        chunk,
        encoder.encode("\r\n"),
      );
    }
    chunks.push(encoder.encode("0\r\n\r\n"));
  } else chunks.push(body);
  return { body, wire: concatenate(chunks), size, chunked };
}
const cases = [
  workload(1024 * 1024, true),
  workload(8 * 1024 * 1024, true),
  workload(8 * 1024 * 1024, false),
];
const allocations = [];
const digest = createHash("sha256");
for (const input of cases) {
  allocatedBytes = 0;
  const response = context.parseResponse(input.wire);
  const output = new Uint8Array(response.body);
  assert.equal(response.status, 200);
  assert.deepEqual(output, input.body);
  assert.ok(
    !response.headers.some(
      ([name]) => name.toLowerCase() === "transfer-encoding",
    ),
  );
  allocations.push({
    bodyBytes: input.size,
    chunked: input.chunked,
    allocatedBytes,
  });
  digest.update(output);
  // Returned bytes must remain owned and unchanged when transport storage is reused.
  const first = output[0];
  input.wire.fill(255);
  assert.equal(output[0], first);
}
// Restore the deliberately mutated input outside measured work.
const measuredCases = cases.map((input) => workload(input.size, input.chunked));
const durations = [];
for (let iteration = 0; iteration < 25; iteration++) {
  global.gc?.();
  const start = performance.now();
  for (let repeat = 0; repeat < 8; repeat++)
    for (const input of measuredCases) {
      const result = context.parseResponse(input.wire);
      assert.equal(result.body.byteLength, input.size);
    }
  if (iteration >= 5) durations.push(performance.now() - start);
}
durations.sort((a, b) => a - b);
console.error(
  `BENCH_METRIC ${JSON.stringify({ runtime: process.version, platform: `${process.platform}-${process.arch}`, iterations: durations.length, medianMs: (durations[9] + durations[10]) / 2, p95Ms: durations[18], minMs: durations[0], maxMs: durations.at(-1), allocations, maxRssKiB: process.resourceUsage().maxRSS })}`,
);
console.log(
  JSON.stringify({
    bodySha256: digest.digest("hex"),
    equivalentCases: cases.length,
  }),
);
