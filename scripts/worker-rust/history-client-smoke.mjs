// Native HTTP client and native durable transactions against the real Rust server.
// Controlled enrollment/control worker and prepared canonical content are reference
// fixtures. This does not exercise the pending production capture/provider runtime.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  settingsHttpFixture,
  settingsChat,
  settingsWorker,
} from "../server-rust/native-settings-http-fixture.mjs";
import { NativeHistoryClient } from "../../cantrip_worker/src/native-history-client.ts";
import { prepareNativeHistoryRenderedItem } from "../../cantrip_worker/src/native-history-prepare-item.ts";
const { values } = parseArgs({
  options: {
    client: { type: "string" },
    history: { type: "string" },
    server: { type: "string" },
    repository: { type: "string" },
  },
});
for (const key of ["client", "history", "server", "repository"])
  assert.ok(values[key], `Pass --${key}`);
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-native-history-client-"),
);
async function* lines(stream) {
  stream.setEncoding("utf8");
  let partial = "";
  for await (const chunk of stream) {
    partial += chunk;
    let end;
    while ((end = partial.indexOf("\n")) >= 0) {
      yield partial.slice(0, end);
      partial = partial.slice(end + 1);
    }
  }
  assert.equal(partial, "");
}
function driver(binary) {
  const child = spawn(binary, [], {
    env: { ...process.env, PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const output = lines(child.stdout);
  return {
    async call(input) {
      child.stdin.write(JSON.stringify(input) + "\n");
      const line = await output.next();
      assert.equal(line.done, false);
      return JSON.parse(line.value);
    },
    async stop() {
      child.stdin.end();
      assert.equal(await completion, 0);
    },
  };
}
let h, history, client, proxy;
let dropIngest = true,
  accepted;
const deliveries = [];
try {
  h = await settingsHttpFixture({
    kind: "rust",
    profile: "none",
    root,
    executable: values.server,
    repositoryExecutable: values.repository,
    databaseMode: "pglite",
    result: { observations: [], snapshotProofs: 0, defaultsProofs: 0 },
  });
  proxy = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const response = await fetch(h.fixture.server.origin + req.url, {
        method: req.method,
        headers: {
          authorization: req.headers.authorization,
          "content-type": "application/json",
        },
        body,
        redirect: "error",
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (req.url.endsWith("/ingest")) {
        deliveries.push({
          body,
          status: response.status,
          receipt: JSON.parse(bytes),
        });
        if (response.ok && dropIngest) {
          dropIngest = false;
          accepted = JSON.parse(bytes);
          req.socket.destroy();
          return;
        }
      }
      res.statusCode = response.status;
      res.setHeader("content-type", "application/json");
      res.end(bytes);
    } catch {
      res.statusCode = 502;
      res.end("{}");
    }
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  client = driver(values.client);
  history = driver(values.history);
  async function invoke(action, input, extra = {}) {
    const result = await client.call({
      serverUrl: origin,
      workerId: settingsWorker,
      token: h.credential,
      action,
      input,
      ...extra,
    });
    assert.equal(result.ok, true, result.error);
    return result.value;
  }
  async function local(input) {
    const result = await history.call(input);
    assert.equal(result.ok, true, result.error);
    return result.value;
  }
  const binding = await invoke("open", {
    chatId: settingsChat,
    threadId: "thread",
    provenance: { kind: "current" },
  });
  const reference = new NativeHistoryClient({
    serverUrl: origin,
    workerId: settingsWorker,
    token: () => h.credential,
  });
  assert.deepEqual(
    await reference.open({
      chatId: settingsChat,
      threadId: "thread",
      provenance: { kind: "binding", bindingId: binding.id },
    }),
    binding,
  );
  const identity = {
    threadId: "thread",
    turnId: "native-http-turn",
    itemId: "native-http-item",
    component: "assistant",
    identityKind: "canonical",
  };
  const resolve = {
    chatId: settingsChat,
    bindingId: binding.id,
    items: [{ identity, association: { kind: "native" } }],
  };
  const [mapping] = await invoke("resolve", resolve);
  assert.deepEqual(await reference.resolve(resolve), [mapping]);
  const encryption = {
    ownerId: () => h.owner,
    serverIdentity: () => h.serverId,
    componentKey: (_scope, revision = 1) => ({
      key: new Uint8Array(32).fill(revision),
      keyRevision: revision,
    }),
  };
  const marker = "synthetic-native-history-client-private";
  const source = {
    id: identity.itemId,
    identityKind: "canonical",
    revision: 1,
    ordinal: 0,
    body: { type: "agentMessage", text: marker },
    lifecycle: "completed",
    completeBody: true,
    startedAtMs: null,
    completedAtMs: null,
    origin: { generation: "fixture", sequence: 1, kind: "snapshot" },
    conflicts: [],
  };
  const item = await prepareNativeHistoryRenderedItem({
    service: encryption,
    binding,
    mapping,
    revision: 1,
    order: { turn: 0, item: 0, component: 0 },
    attachments: [],
    rendered: {
      identity,
      source,
      message: {
        role: "assistant",
        mode: "default",
        content: [{ type: "text", text: marker }],
      },
    },
  });
  const batch = { items: [item], turns: [] };
  assert.equal(JSON.stringify(batch).includes(marker), false);
  const scope = {
    workerId: settingsWorker,
    chatId: settingsChat,
    bindingId: binding.id,
  };
  const config = {
    workerId: settingsWorker,
    serverUrl: origin,
    token: h.credential,
    state: { retained: "frozen" },
    batches: [batch],
  };
  async function reopen() {
    await local({
      op: "identity",
      state: { owner: h.owner, server: h.serverId, revision: 1 },
    });
    await local({
      op: "open",
      handle: "http",
      directory: path.join(root, "source"),
      ...scope,
      threadId: "thread",
    });
    await local({
      op: "outbox.open",
      handle: "http",
      directory: path.join(root, "outbox"),
      ...scope,
    });
    return local({
      op: "projection.open",
      handle: "http",
      source: "http",
      outbox: "http",
      directory: path.join(root, "projection"),
      config,
      ...scope,
    });
  }
  const projection = await reopen();
  await local({
    op: "append",
    handle: "http",
    frame: {
      kind: "notification",
      generation: "fixture",
      sequence: 1,
      threadId: "thread",
      receivedAtMs: 1,
      method: "item/completed",
      params: {
        turnId: identity.turnId,
        item: { id: identity.itemId, type: "agentMessage", text: marker },
      },
    },
  });
  const first = await history.call({ op: "projection.drain", handle: "http" });
  assert.equal(first.ok, false);
  assert.equal(first.error, "fetch failed");
  assert.ok(
    accepted?.committed,
    "actual upstream canonical commit preceded lost reply",
  );
  assert.equal(
    (await local({ op: "projection.checkpoint", handle: "http" })).cursor
      .sequence,
    0,
  );
  const staged = await readFile(
    path.join(projection.directory, "0000000000000001.stage.json"),
    "utf8",
  );
  const pending = await local({ op: "outbox.pending", handle: "http" });
  assert.equal(pending.length, 1);
  const archive = { chatId: settingsChat, bindingId: binding.id };
  const committedBefore = await invoke("archiveBatches", archive);
  assert.equal(committedBefore.batches.length, 1);
  assert.deepEqual(committedBefore.batches[0].receipt, accepted);
  await history.stop();
  history = null;
  await client.stop();
  client = null;
  h.worker.close();
  await h.fixture.close();
  await h.fixture.start();
  history = driver(values.history);
  client = driver(values.client);
  config.projectError = "must not recompute a frozen canonical transaction";
  await reopen();
  await local({ op: "projection.drain", handle: "http" });
  const checkpoint = await local({
    op: "projection.checkpoint",
    handle: "http",
  });
  assert.equal(checkpoint.cursor.sequence, 1);
  assert.deepEqual(checkpoint.state, { retained: "frozen" });
  assert.deepEqual(await local({ op: "outbox.pending", handle: "http" }), []);
  assert.equal(
    await readFile(
      path.join(projection.directory, "0000000000000001.stage.json"),
      "utf8",
    ),
    staged,
  );
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0].body, deliveries[1].body);
  assert.deepEqual(deliveries[1].receipt, accepted);
  for (const action of ["archive", "archiveTurns", "archiveBatches"])
    assert.deepEqual(
      await invoke(action, archive),
      await reference[action](archive),
    );
  const finalArchive = await invoke("archiveBatches", archive);
  assert.equal(finalArchive.batches.length, 1);
  assert.deepEqual(finalArchive.batches[0].receipt, accepted);
  const invalid = await client.call({
    serverUrl: origin,
    workerId: settingsWorker,
    token: "not-an-enrolled-worker",
    action: "archive",
    input: archive,
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.status, 401);
  assert.equal(h.fixture.server.diagnostics().includes(marker), false);
  console.log(
    JSON.stringify({
      status: "passed",
      actualRustServer: true,
      actualNativeClient: true,
      nativeProjectionAndOutbox: true,
      canonicalAckLostAndRecovered: true,
      nativeAndServerProcessRestart: true,
      exactFrozenRetry: true,
      archiveReaders: 3,
      canonicalBatchCount: 1,
      scope:
        "controlled canonical preparation and control worker; production capture/runtime integration pending",
      runtime: "macOS ARM64",
      rootRemovedOnExit: true,
    }),
  );
} finally {
  if (history) await history.stop();
  if (client) await client.stop();
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
  await h?.close();
  await rm(root, { recursive: true, force: true });
}
