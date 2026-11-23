import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { id, input, opaque } from "./computer-use-http-fixtures.mjs";

// Inspect the actual early HTTP rejection without continuing a multi-MiB upload
// after the reference server closes it (which makes fetch reject with EPIPE).
async function advertisedUpload(url, options) {
  return new Promise((resolve, reject) => {
    const headers = {
      ...Object.fromEntries(
        Object.entries(options.headers).map(([key, value]) => [
          key,
          String(value),
        ]),
      ),
      "content-length": Buffer.byteLength(options.body),
      connection: "close",
    };
    let responded = false;
    const caller = request(
      url,
      { method: options.method, headers, agent: false },
      (response) => {
        responded = true;
        const chunks = [];
        response.on("data", (bytes) => chunks.push(bytes));
        response.on("error", reject);
        response.on("end", () => {
          const headers = new Headers();
          for (let i = 0; i < response.rawHeaders.length; i += 2)
            headers.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode,
              headers,
            }),
          );
        });
      },
    );
    caller.on("error", (error) => {
      if (!responded) reject(error);
    });
    caller.setTimeout(10000, () =>
      caller.destroy(
        new Error("Oversized request did not receive its early HTTP response"),
      ),
    );
    caller.end(options.body.slice(0, 1));
  });
}

export async function computerUseLimitCases({ state, visit, result }) {
  const root = "/api/chats/chat/computer-use",
    op = root + "/operation";
  for (const route of [
    op,
    root + "/preview",
    root + "/preview/stop",
    "/api/internal/computer-use/authority",
  ]) {
    await visit("unsupported HEAD " + route, "HEAD", route, { status: 404 });
    await visit("unsupported PUT " + route, "PUT", route, {
      status: 404,
      json: {},
    });
    await visit("malformed JSON " + route, "POST", route, {
      status: 400,
      raw: "{",
      headers: { "content-type": "application/json" },
    });
    await visit("unsupported media " + route, "POST", route, {
      status: route === op ? 400 : 415,
      raw: "body",
      headers: { "content-type": "text/csv" },
    });
  }
  await visit(
    "authority 32KiB parser limit",
    "POST",
    "/api/internal/computer-use/authority",
    {
      status: 413,
      raw: "x".repeat(32769),
      headers: { "content-type": "application/json" },
    },
  );
  const chunk = (command, sequence) => ({
    type: "computer-use.snapshot.chunk",
    operationId: command.request.operationId,
    sequence,
    protectedContent: opaque(),
  });
  state.events = (command) =>
    Array.from({ length: 64 }, (_, sequence) => chunk(command, sequence));
  const complete = await visit("64 opaque snapshot chunks", "POST", op, {
    json: input(200),
  });
  assert.equal(complete.chunks.length, 64);
  state.events = (command) =>
    Array.from({ length: 65 }, (_, sequence) =>
      chunk(command, Math.min(sequence, 63)),
    );
  await visit("overflow after 64 opaque chunks", "POST", op, {
    status: 502,
    json: input(201),
  });
  state.events = (command) => [chunk(command, 0)];
  await visit("chunks forbidden for input operation", "POST", op, {
    status: 502,
    json: input(202, "input.click"),
  });
  delete state.events;
  const bytes = 16 * 1024 * 1024 + 16;
  const packet = input(203, "capabilities.get");
  packet.protectedContent.envelope.ciphertext =
    Buffer.alloc(bytes).toString("base64url");
  const started = performance.now();
  await visit("full 16MiB protected control accepted", "POST", op, {
    json: packet,
    timeoutMs: 60000,
  });
  const received =
    state.commands.at(-1).request.protectedContent.envelope.ciphertext;
  assert.equal(received.length, Math.ceil((bytes * 4) / 3));
  assert.equal(received, packet.protectedContent.envelope.ciphertext);
  (result.largeControl ??= []).push({
    bytes,
    encodedCharacters: received.length,
    sha256: createHash("sha256").update(received).digest("hex"),
    elapsedMs: performance.now() - started,
  });
  result.cases.push({
    name: "max-size protected control crosses actual HTTP and worker sockets intact",
    bytes,
    sha256: createHash("sha256").update(received).digest("hex"),
  });
  await visit(
    "custom operation body limit rejects oversized advertised upload",
    "POST",
    op,
    {
      status: 413,
      raw: "x".repeat(Math.ceil((bytes * 4) / 3) + 1025),
      headers: { "content-type": "application/json" },
      timeoutMs: 60000,
      fetcher: advertisedUpload,
    },
  );
  assert.equal(complete.response.operationId, id(200));
}
