import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeCommandSettlementSchema } from "../../packages/protocol/dist/index.js";

const prompt = "Retain this exact deferred input 🌲";
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function fixtureCodex(
  root,
  codex,
  {
    scenario = "deferred",
    marker = path.join(root, "deferred-codex-once"),
    input = prompt,
    socketFile,
  } = {},
) {
  const executable = path.join(root, `codex-${scenario}-fixture`);
  const args = [
    process.execPath,
    fileURLToPath(new URL("./deferred-codex-peer.mjs", import.meta.url)),
    path.resolve(codex),
    marker,
    input,
    scenario,
  ];
  const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
  await writeFile(
    executable,
    [
      "#!/bin/sh",
      ...(socketFile
        ? [
            `if [ "$1" = --remote ]; then umask 077; printf '%s\\n' "$2" > ${quote(socketFile)}; exec ${quote(path.resolve(codex))} "$@"; fi`,
          ]
        : []),
      `exec ${args.map(quote).join(" ")} "$@"`,
      "",
    ].join("\n"),
    {
      mode: 0o700,
    },
  );
  return executable;
}

// Forward the actual worker control socket and HTTP requests. Before restart,
// close only deferred receipt requests without forwarding them to Core.
export async function deferredReceiptProxy(origin, { handoffAction } = {}) {
  const sockets = new Set();
  let hold = true;
  let withheld;
  const relay = createServer(async (req, reply) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (hold && req.url === "/api/internal/native-commands/receipt") {
        const value = JSON.parse(body);
        if (value.deferred) {
          withheld = nativeCommandSettlementSchema.parse(value);
          reply.destroy();
          return;
        }
      }
      const handoffRequest =
        handoffAction && req.url === "/api/internal/native-runtime-handoffs"
          ? JSON.parse(body)
          : null;
      const upstream = request(
        origin + req.url,
        {
          method: req.method,
          headers: { ...req.headers, host: new URL(origin).host },
        },
        (response) => {
          if (
            hold &&
            handoffRequest &&
            handoffRequest.action === handoffAction &&
            response.statusCode === 200
          ) {
            withheld = handoffRequest.operationId;
            response.resume();
            reply.destroy();
            return;
          }
          reply.writeHead(response.statusCode, response.headers);
          response.pipe(reply);
        },
      );
      upstream.on("error", () => reply.destroy());
      upstream.end(body);
    } catch (error) {
      reply.destroy(error);
    }
  });
  relay.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  relay.on("upgrade", (req, socket, head) => {
    const upstream = request(origin + req.url, { headers: req.headers });
    socket.on("error", () => upstream.destroy());
    upstream.on("upgrade", (response, peer, remainder) => {
      peer.on("error", () => socket.destroy());
      const raw = [
        `HTTP/1.1 ${response.statusCode} ${response.statusMessage}`,
        ...Object.entries(response.headers).map(
          ([name, value]) => `${name}: ${value}`,
        ),
        "\r\n",
      ];
      socket.write(raw.join("\r\n"));
      if (head.length) peer.write(head);
      if (remainder.length) socket.write(remainder);
      socket.pipe(peer).pipe(socket);
      peer.once("close", () => socket.destroy());
      socket.once("close", () => peer.destroy());
    });
    upstream.on("error", () => socket.destroy());
    upstream.on("response", () => socket.destroy());
    upstream.end();
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  return {
    origin: `http://127.0.0.1:${relay.address().port}`,
    open: () => {
      hold = false;
    },
    withheld: () => withheld,
    close: async () => {
      const closed = new Promise((resolve) => relay.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

export async function verifyDeferredReceipt({
  data,
  proxy,
  ownerId,
  workerId,
  model,
  chatId,
  chatUrl,
  encryptedTurn,
  call,
  eventually,
  startWorker,
  stopWorker,
  workerDiagnostics,
}) {
  const serverId = (await call("GET", "/api/bootstrap", 200)).server.id;
  const scope = { serverId, ownerId, workerId };
  const directory = path.join(
    data,
    "native-deferred-settlements",
    digest(scope),
  );
  const turn = await encryptedTurn(prompt, model.profile.id);
  const answer = model.model.reply({ text: "Deferred input continued." });
  const prior = model.model.requests.filter(
    ({ method }) => method === "POST",
  ).length;
  const submitted = await call("POST", `${chatUrl}/turns`, 202, turn);
  assert.equal(submitted.status, "queued");
  assert.equal(submitted.prompt.id, turn.queuedPrompt.id);
  const settlement = await eventually(proxy.withheld, (body) => {
    assert.equal(body?.deferred?.inputConsumed, false);
    assert.equal(body.deferred.retainedPrompt, undefined);
    assert.equal(body.status, "rejected");
  });
  const stem = path.join(
    directory,
    digest([settlement.operationId, settlement.operationGeneration]),
  );
  const pending = `${stem}.pending.json`;
  const ack = `${stem}.ack.json`;
  const record = { scope, settlement };
  assert.equal(await readFile(pending, "utf8"), JSON.stringify(record));
  assert.ok(!JSON.stringify(record).includes(prompt));
  assert.equal(answer.request, null);
  await eventually(workerDiagnostics, (value) =>
    assert.match(
      value,
      /The native input was deferred while its permission settings settle/u,
    ),
  );
  assert.deepEqual(await stopWorker(), { code: 0, signal: null });
  await assert.rejects(stat(ack), { code: "ENOENT" });
  // Reopen a file serialized by Node using the old worker's schema order.
  await writeFile(pending, JSON.stringify(record));
  proxy.open();
  await startWorker();
  await eventually(
    () => readFile(ack, "utf8").then(JSON.parse),
    (saved) => {
      assert.equal(saved.digest, digest(record));
      assert.equal(saved.result.receipt.chatId, chatId);
      assert.equal(saved.result.receipt.operationId, settlement.operationId);
      assert.equal(
        saved.result.receipt.rejectionCode,
        "native-settings-pending",
      );
    },
  );
  await eventually(
    () => stat(pending).catch((error) => error.code),
    (value) => assert.equal(value, "ENOENT"),
  );
  await eventually(
    () => answer,
    (value) => assert.equal(value.request?.completed, true),
    35_000,
  );
  assert.ok(JSON.stringify(answer.request.input.input).includes(prompt));
  await eventually(
    () => call("GET", `${chatUrl}/messages`, 200),
    ({ messages }) => {
      assert.equal(
        messages.filter(({ id }) => id === turn.message.id).length,
        1,
      );
      assert.equal(
        messages.filter(
          (message) =>
            (message.classification?.role ?? message.role) === "assistant",
        ).length,
        2,
      );
    },
  );
  const replay = await call("POST", `${chatUrl}/turns`, 200, turn);
  assert.equal(replay.message.id, turn.message.id);
  assert.equal(
    model.model.requests.filter(({ method }) => method === "POST").length,
    prior + 1,
  );
  assert.deepEqual(model.model.failures, []);
}
