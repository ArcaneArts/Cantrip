import assert from "node:assert/strict";
import {
  settingsChat as chat,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import { command } from "./native-command-admission-cases.mjs";
import { nativeQueueHttpContent } from "./native-queue-http-content.mjs";
import { nativeQueueHttpImports } from "./native-queue-http-imports.mjs";
import { nativeQueueHttpAuthorization } from "./native-queue-http-authorization.mjs";

export async function nativeQueueHttpCases({ h, client, result }) {
  const session = h.prepared[chat].session;
  const content = nativeQueueHttpContent(h, result);
  const auth = {
    client: "worker",
    headers: { authorization: "Bearer " + h.credential },
  };
  const call = async (name, action, input, extra = {}) => {
    const value = await h.visit(
      name,
      "POST",
      "/api/internal/native-queue/" + action,
      {
        ...auth,
        json: input,
        ...extra,
      },
    );
    await content.prove(value);
    return value;
  };
  for (const action of [
    "lookup",
    "read",
    "mutate",
    "import",
    "import-ack",
    "start-receipt",
  ]) {
    await call(
      action + " validates before authentication",
      action,
      {},
      { headers: {}, status: 400 },
    );
    await h.visit(
      action + " unsupported method",
      "GET",
      "/api/internal/native-queue/" + action,
      { ...auth, status: 404 },
    );
  }
  const read = { workerId: worker, session };
  await call("read requires worker credential", "read", read, {
    headers: {},
    status: 401,
  });
  const empty = {
    revision: 0,
    paused: false,
    goalRecovery: null,
    items: [],
    claims: [],
    pendingImports: [],
  };
  assert.deepEqual(await call("empty queue read", "read", read), empty);
  assert.deepEqual(
    await content.sdk("worker SDK reads empty queue", () =>
      client.read({ session }),
    ),
    empty,
  );
  for (const field of [
    "threadId",
    "projectId",
    "placementId",
    "modelRouteId",
    "providerAccountId",
  ]) {
    assert.deepEqual(
      await call(
        "stale queue " + field,
        "read",
        { ...read, session: { ...session, [field]: "stale" } },
        { status: 409 },
      ),
      {
        statusCode: 409,
        code: "stale-queue-session",
        error: "Conflict",
        message: "stale-queue-session",
      },
    );
  }
  const make = (kind, operationId) =>
    command({
      workerId: worker,
      operationId,
      method: "thread/queue/" + kind,
      session,
    });
  const admission = make("add", "http-queue-add");
  assert.deepEqual(
    await call("unknown queue operation", "lookup", { admission }),
    { found: false },
  );
  assert.deepEqual(
    await call("empty import", "import", {
      ...read,
      runnerGeneration: "runner",
      items: [],
    }),
    { ...empty, imports: [] },
  );
  assert.deepEqual(
    await call(
      "missing queue receipt",
      "start-receipt",
      { ...read, claimId: "missing" },
      { status: 409 },
    ),
    { code: "queue-claim-not-found" },
  );
  assert.deepEqual(
    await call(
      "missing queue import",
      "import-ack",
      {
        ...read,
        runnerGeneration: "runner",
        importId: "missing",
        sourceDigest: "b".repeat(64),
        receipt: { deleted: true, conflict: false },
      },
      { status: 409 },
    ),
    { code: "stale-queue-import" },
  );
  const promptInput = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    key: "http-queue-encrypted-prompt",
    text: "Private queued HTTP text 🍄",
  };
  const prompt = await content.prompt(promptInput);
  await nativeQueueHttpAuthorization({ call, read, admission, prompt });
  const input = {
    admission,
    expectedRevision: 0,
    mutation: { kind: "add", prompt, attachments: [] },
  };
  const added = await call("add frozen encrypted queue item", "mutate", input);
  assert.equal(added.receipt.status, "applied");
  assert.equal(added.receipt.startsExecution, false);
  assert.equal(added.revision, 1);
  assert.equal(added.items.length, 1);
  assert.equal(added.acceptedItem.id, prompt.id);
  assert.deepEqual(
    await call("immutable queue mutation replay", "mutate", {
      ...input,
      expectedRevision: 999,
    }),
    added,
  );
  const found = await call("lookup exact immutable mutation", "lookup", {
    admission,
  });
  assert.deepEqual(found, { found: true, ...added });
  assert.deepEqual(
    await call(
      "conflicting queue operation digest",
      "lookup",
      { admission: { ...admission, payloadDigest: "b".repeat(64) } },
      { status: 409 },
    ),
    {
      statusCode: 409,
      code: "operation-id-conflict",
      error: "Conflict",
      message: "operation-id-conflict",
    },
  );
  const wrong = {
    ...input,
    admission: { ...admission, method: "skills/list" },
  };
  assert.deepEqual(
    await call(
      "queue method is checked before receipt replay",
      "mutate",
      wrong,
      { status: 409 },
    ),
    { code: "queue-method-mismatch" },
  );
  const stale = await call("stale optimistic queue revision", "mutate", {
    ...input,
    admission: make("add", "http-queue-stale"),
  });
  assert.equal(stale.receipt.status, "rejected");
  assert.equal(stale.receipt.rejectionCode, "queue-revision-conflict");
  const updatedPrompt = await content.prompt({
    ...promptInput,
    text: "Private updated queued HTTP text 🌲",
    reasoningEffort: "low",
  });
  const updated = await call("update frozen queue item", "mutate", {
    admission: make("update", "http-queue-update"),
    expectedRevision: 1,
    mutation: {
      kind: "update",
      id: prompt.id,
      expectedItemRevision: 0,
      prompt: updatedPrompt,
      attachments: [],
    },
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.receipt.status, "applied");
  const reordered = await call("reorder frozen queue", "mutate", {
    admission: make("reorder", "http-queue-reorder"),
    expectedRevision: 2,
    mutation: { kind: "reorder", ids: [prompt.id] },
  });
  assert.equal(reordered.revision, 3);
  const item = reordered.items[0];
  const removed = await call("remove exact frozen queue revision", "mutate", {
    admission: make("delete", "http-queue-delete"),
    expectedRevision: 3,
    mutation: {
      kind: "delete",
      id: prompt.id,
      expectedItemRevision: item.revision,
    },
  });
  assert.equal(removed.revision, 4);
  assert.deepEqual(removed.items, []);
  const start = await call("start empty queue retains rejection", "mutate", {
    admission: make("start", "http-queue-start"),
    expectedRevision: 4,
    mutation: { kind: "start" },
  });
  assert.equal(start.receipt.status, "rejected");
  assert.equal(start.receipt.rejectionCode, "queue-item-unavailable");
  assert.deepEqual(
    (
      await content.sdk("worker SDK looks up original immutable receipt", () =>
        client.lookup({ admission: { ...admission, workerId: undefined } }),
      )
    ).receipt,
    added.receipt,
  );
  // Route validation exposes its own fixed code after the real binary parser.
  await call(
    "binary body is parsed before schema rejection",
    "read",
    undefined,
    {
      raw: Buffer.from([0xff, 0]),
      headers: { ...auth.headers, "content-type": "application/octet-stream" },
      status: 400,
    },
  );
  await nativeQueueHttpImports({ h, client, result, content, call, read });
  content.finish();
}
