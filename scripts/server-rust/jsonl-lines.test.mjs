import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { jsonLines } from "./jsonl-lines.mjs";

test("JSON messages retain Unicode separators and split UTF-8 characters", async () => {
  const values = [
    { preview: "History 😀 \ud800\u2028", second: "paragraph\u2029end" },
    { controls: "\r\n\t\u0000", emoji: "🦀", done: true },
  ];
  const wire = Buffer.from(
    values.map((v) => JSON.stringify(v)).join("\n") + "\n",
  );
  const chunks = [...wire].map((byte) => Buffer.from([byte]));
  const observed = [];
  for await (const line of jsonLines(Readable.from(chunks)))
    observed.push(JSON.parse(line));
  assert.deepEqual(observed, values);
});

test("JSON framing preserves blank lines, CRLF whitespace and a final partial line", async () => {
  const observed = [];
  for await (const line of jsonLines(
    Readable.from([Buffer.from('\n{"a":1}\r\n{"b":2}')]),
  ))
    observed.push(line);
  assert.deepEqual(observed, ["", '{"a":1}\r', '{"b":2}']);
});
