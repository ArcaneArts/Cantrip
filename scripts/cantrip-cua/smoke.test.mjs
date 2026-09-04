import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { smokeCantripCua, verifySnapshot } from "./smoke.mjs";
import {
  encodeFrame,
  FrameDecoder,
  FramedCuaProcess,
  MAX_HEADER_BYTES,
  MAX_PAYLOAD_BYTES,
} from "./wire.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const wireUrl = new URL("./wire.mjs", import.meta.url).href;
const response = (requestId = 1, data = {}) => ({
  version: 1,
  message: { kind: "response", requestId, result: { status: "ok", data } },
});
const event = (sequence = 1) => ({
  version: 1,
  message: {
    kind: "event",
    sequence,
    sessionId: "fixture",
    event: { kind: "cursorChanged" },
  },
});

function rawFrame(header, payloadLength = 0) {
  const bytes = Buffer.isBuffer(header)
    ? header
    : Buffer.from(JSON.stringify(header));
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(bytes.length, 0);
  prefix.writeUInt32BE(payloadLength, 4);
  return Buffer.concat([prefix, bytes]);
}

function fixtureProcess(source, timeoutMs = 3_000) {
  return new FramedCuaProcess(process.execPath, {
    args: [
      "--input-type=module",
      "-e",
      `import { encodeFrame, FrameDecoder } from ${JSON.stringify(wireUrl)}; ${source}`,
    ],
    timeoutMs,
  });
}

test("decoder preserves fragmented binary payloads and coalesced events/responses", () => {
  const expected = [
    { header: event(), payload: Buffer.alloc(0) },
    {
      header: response(1, { mediaType: "image/png" }),
      payload: Buffer.from([0, 255, 123, 10, 13, 128]),
    },
    { header: response(2, { done: true }), payload: Buffer.alloc(0) },
  ];
  const bytes = Buffer.concat(
    expected.map(({ header, payload }) => encodeFrame(header, payload)),
  );
  for (const chunkSize of [1, 3, 8, 32, bytes.length]) {
    const frames = [];
    const decoder = new FrameDecoder((frame) => frames.push(frame));
    for (let offset = 0; offset < bytes.length; offset += chunkSize)
      decoder.push(bytes.subarray(offset, offset + chunkSize));
    decoder.finish();
    assert.deepEqual(frames, expected);
    assert.equal(decoder.bufferedBytes, 0);
  }
});

test("decoder rejects oversized lengths from the prefix alone", () => {
  for (const [headerBytes, payloadBytes] of [
    [0, 0],
    [MAX_HEADER_BYTES + 1, 0],
    [12, MAX_PAYLOAD_BYTES + 1],
    [0xffffffff, 0xffffffff],
  ]) {
    const prefix = Buffer.alloc(8);
    prefix.writeUInt32BE(headerBytes, 0);
    prefix.writeUInt32BE(payloadBytes, 4);
    const decoder = new FrameDecoder(() =>
      assert.fail("Unexpected complete frame"),
    );
    assert.throws(() => decoder.push(prefix), /length|limit/u);
    assert.equal(decoder.bufferedBytes, 8);
  }
});

test("decoder validates header before accepting any payload", () => {
  for (const header of [
    { ...response(), version: 2 },
    { ...response(), extra: true },
    response(0),
    response(Number.MAX_SAFE_INTEGER + 1),
    {
      version: 1,
      message: { kind: "response", requestId: 1, result: { status: "ok" } },
    },
    {
      version: 1,
      message: {
        kind: "response",
        requestId: 1,
        result: { status: "error", error: "secret" },
      },
    },
  ]) {
    const decoder = new FrameDecoder(() =>
      assert.fail("Unexpected complete frame"),
    );
    assert.throws(
      () => decoder.push(rawFrame(header, MAX_PAYLOAD_BYTES)),
      /Invalid/u,
    );
  }
  for (const header of [
    event(),
    { version: 1, message: { kind: "cancel", requestId: 1 } },
    {
      version: 1,
      message: {
        kind: "response",
        requestId: 1,
        result: {
          status: "error",
          error: { code: "unsupported", message: "private detail" },
        },
      },
    },
  ]) {
    const decoder = new FrameDecoder(() =>
      assert.fail("Unexpected complete frame"),
    );
    assert.throws(
      () => decoder.push(rawFrame(header, MAX_PAYLOAD_BYTES)),
      /Only successful/u,
    );
  }
});

test("decoder rejects invalid UTF-8 and truncated frames at EOF", () => {
  const invalidUtf8 = new FrameDecoder(() =>
    assert.fail("Unexpected complete frame"),
  );
  assert.throws(
    () => invalidUtf8.push(rawFrame(Buffer.from([0xff]))),
    /UTF-8/u,
  );
  const bytes = encodeFrame(response(), Buffer.from([1, 2, 3]));
  for (const count of [1, 7, 8, 15, bytes.length - 1]) {
    const decoder = new FrameDecoder(() =>
      assert.fail("Unexpected complete frame"),
    );
    decoder.push(bytes.subarray(0, count));
    assert.throws(() => decoder.finish(), /inside a frame/u);
  }
});

test("encoder applies transport limits and permits only successful response payloads", () => {
  assert.throws(
    () => encodeFrame(event(), Buffer.from([1])),
    /Only successful/u,
  );
  assert.throws(
    () => encodeFrame(response(1, "x".repeat(MAX_HEADER_BYTES))),
    /header exceeds/u,
  );
  assert.throws(
    () => encodeFrame(response(), Buffer.alloc(MAX_PAYLOAD_BYTES + 1)),
    /payload length/u,
  );
});

test("actual child transport accepts interleaved events and exits cleanly on stdin EOF", async () => {
  const child = fixtureProcess(`
    const decoder = new FrameDecoder(({ header }) => {
      process.stdout.write(encodeFrame({ version: 1, message: { kind: 'event', sequence: header.message.requestId, sessionId: null, event: { kind: 'observed' } } }));
      process.stdout.write(encodeFrame({ version: 1, message: { kind: 'response', requestId: header.message.requestId, result: { status: 'ok', data: { acknowledged: true } } } }));
    });
    process.stdin.on('data', chunk => decoder.push(chunk));
  `);
  try {
    assert.deepEqual(
      (await child.request({ operation: "capabilities.get" })).data,
      { acknowledged: true },
    );
    assert.deepEqual(
      (await child.request({ operation: "targets.list" })).data,
      { acknowledged: true },
    );
    await child.close();
    assert.equal(child.eventCount, 2);
  } finally {
    await child.dispose();
  }
});

test("actual child transport rejects unrelated and duplicate request responses", async () => {
  for (const frames of [[response(99)], [response(1), response(1)]]) {
    const bytes = Buffer.concat(frames.map((header) => encodeFrame(header)));
    const child = fixtureProcess(
      `process.stdin.once('data', () => process.stdout.write(Buffer.from(${JSON.stringify(bytes.toString("base64"))}, 'base64'))); process.stdin.resume();`,
    );
    try {
      await assert.rejects(async () => {
        await child.request({ operation: "capabilities.get" });
        await child.close();
      }, /pending request/u);
    } finally {
      await child.dispose();
    }
  }
});

test("actual child transport rejects non-increasing event sequences", async () => {
  const bytes = Buffer.concat([encodeFrame(event(2)), encodeFrame(event(2))]);
  const child = fixtureProcess(
    `process.stdout.write(Buffer.from(${JSON.stringify(bytes.toString("base64"))}, 'base64')); process.stdin.resume();`,
  );
  try {
    await assert.rejects(
      child.request({ operation: "capabilities.get" }),
      /sequence or count/u,
    );
  } finally {
    await child.dispose();
  }
});

test("actual child errors are bounded and do not disclose native messages", async () => {
  const header = {
    version: 1,
    message: {
      kind: "response",
      requestId: 1,
      result: {
        status: "error",
        error: { code: "permission-denied", message: "private target title" },
      },
    },
  };
  const child = fixtureProcess(
    `process.stdout.write(Buffer.from(${JSON.stringify(encodeFrame(header).toString("base64"))}, 'base64')); process.stdin.resume();`,
  );
  try {
    await assert.rejects(
      child.request({ operation: "targets.list" }),
      (error) => error.message === "CUA operation returned an error outcome.",
    );
    await child.close();
  } finally {
    await child.dispose();
  }
});

test("process deadline terminates a child that ignores graceful termination", async () => {
  const child = fixtureProcess(
    "process.on('SIGTERM', () => {}); process.stdin.resume();",
    200,
  );
  const start = performance.now();
  try {
    await assert.rejects(
      child.request({ operation: "capabilities.get" }),
      /deadline exceeded/u,
    );
  } finally {
    await child.dispose();
  }
  assert.ok(performance.now() - start < 3_000);
});

test("spawn failures and truncated stdout reject requests and finish cleanup", async () => {
  const missing = new FramedCuaProcess(
    path.join(root, "cantrip_cua", "target", "missing-cua-executable"),
  );
  try {
    await assert.rejects(
      missing.request({ operation: "capabilities.get" }),
      /could not be launched|stdin failed/u,
    );
  } finally {
    await missing.dispose();
  }
  const child = fixtureProcess("process.stdout.write(Buffer.from([0, 0, 0]));");
  try {
    await assert.rejects(
      child.request({ operation: "capabilities.get" }),
      /inside a frame/u,
    );
  } finally {
    await child.dispose();
  }
});

test("snapshot verification rejects mismatched metadata, bytes, and digest", () => {
  const binding = { sessionId: "test" };
  const target = { id: "target", generation: 1, pixelWidth: 1, pixelHeight: 1 };
  const appearance = { style: "dot" };
  const position = { x: 0, y: 0 };
  const payload = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6NQAAAAASUVORK5CYII=",
    "base64",
  );
  const data = {
    session: { binding, target, cursor: { appearance, position } },
    image: {
      mediaType: "image/png",
      cursorIncluded: true,
      width: 1,
      height: 1,
      byteCount: payload.length,
      sha256: createHash("sha256").update(payload).digest("hex"),
    },
  };
  const expected = { binding, target, appearance, position };
  assert.equal(
    verifySnapshot({ data, payload }, expected).byteCount,
    payload.length,
  );
  for (const image of [
    { ...data.image, width: 2 },
    { ...data.image, byteCount: 0 },
    { ...data.image, sha256: "0".repeat(64) },
    { ...data.image, cursorIncluded: false },
  ]) {
    assert.throws(
      () => verifySnapshot({ data: { ...data, image }, payload }, expected),
      /verification failed/u,
    );
  }
  assert.throws(
    () =>
      verifySnapshot({ data, payload: Buffer.alloc(payload.length) }, expected),
    /PNG/u,
  );
});

test(
  "compiled Rust executable completes monitor/window capture with every cursor style",
  { timeout: 120_000 },
  async () => {
    const { buildCantripCua } = await import("./build.mjs");
    const binary = buildCantripCua(root);
    const result = await smokeCantripCua(binary);
    assert.equal(result.protocolVersion, 1);
    assert.equal(result.backend, "fake");
    assert.equal(result.targetCount, 2);
    assert.equal(result.snapshots.length, 8);
    assert.equal(
      new Set(result.snapshots.map((snapshot) => snapshot.sha256)).size,
      8,
    );
    assert.ok(result.eventCount >= 30);
    assert.ok(result.elapsedMs < 15_000);
  },
);
