import assert from "node:assert/strict";
import { request } from "node:http";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { eventually } from "./full-worker.mjs";
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const commands = (state, offset) => state.commands.slice(offset);
export async function attachmentFaults({
  f,
  state,
  input,
  visit,
  snapshot,
  evidence,
  result,
}) {
  result.databaseRollback = [];
  for (const table of ["chat_attachment_replicas", "chat_attachments"]) {
    const body = input(),
      before = await snapshot(),
      offset = state.commands.length;
    let renamed = false;
    state.intercept = async (worker, command) => {
      if (
        command.type === "attachment.upload.complete" &&
        command.attachmentId === body.attachmentId
      ) {
        await f.sql([`ALTER TABLE ${table} RENAME TO attachment_fault_table`]);
        renamed = true;
      }
    };
    try {
      const response = await visit(
        "actual INSERT failure " + table,
        "POST",
        "/api/chats/chat/attachments",
        {
          status: 502,
          headers: { "content-type": "application/octet-stream" },
          raw: JSON.stringify(body),
        },
      );
      result.databaseRollback.push({
        table,
        response,
        commands: commands(state, offset),
      });
      assert.equal(
        result.databaseRollback.at(-1).commands.at(-1).command.type,
        "attachment.delete",
      );
    } finally {
      delete state.intercept;
      if (renamed)
        await f.sql([`ALTER TABLE attachment_fault_table RENAME TO ${table}`]);
    }
    const after = await snapshot();
    assert.deepEqual(
      after,
      before,
      "Failed replica INSERT rolls back the already inserted attachment",
    );
    await writeFile(
      path.join(evidence, "actual-insert-rollback-" + table + ".json"),
      JSON.stringify(
        { before, after, ...result.databaseRollback.at(-1) },
        null,
        2,
      ) + "\n",
    );
  }

  const lost = input(11),
    callerBefore = await snapshot(),
    callerOffset = state.commands.length;
  const held = deferred(),
    release = deferred(),
    closed = deferred();
  state.intercept = async (worker, command) => {
    if (
      command.type === "attachment.upload.chunk" &&
      command.attachmentId === lost.attachmentId
    ) {
      held.resolve();
      await release.promise;
    }
  };
  const client = f.client(),
    raw = JSON.stringify(lost);
  const caller = request(f.server.origin + "/api/chats/chat/attachments", {
    method: "POST",
    headers: {
      origin: "http://127.0.0.1:5173",
      "content-type": "application/octet-stream",
      "content-length": Buffer.byteLength(raw),
      cookie: [...client.cookies].map(([k, v]) => k + "=" + v).join("; "),
      ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
    },
  });
  const errors = [];
  caller.on("error", (error) => errors.push(error.code));
  caller.on("close", () => closed.resolve());
  let timer;
  try {
    caller.end(raw);
    await Promise.race([
      held.promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("Caller upload never reached controlled worker chunk"),
            ),
          45000,
        );
      }),
    ]);
    clearTimeout(timer);
    caller.destroy();
    await closed.promise;
    release.resolve();
    const callerAfter = await eventually(snapshot, (sql) =>
      assert.ok(sql.attachments?.some((a) => a.id === lost.attachmentId)),
    );
    assert.equal(
      callerAfter.attachments.length,
      callerBefore.attachments.length + 1,
    );
    assert.equal(
      callerAfter.replicas.find((r) => r.attachment_id === lost.attachmentId)
        .status,
      "ready",
    );
    result.disconnectedCaller = {
      attachmentId: lost.attachmentId,
      errors,
      commands: commands(state, callerOffset),
    };
    assert.equal(
      result.disconnectedCaller.commands.at(-1).command.type,
      "attachment.upload.complete",
    );
    await writeFile(
      path.join(evidence, "caller-loss.json"),
      JSON.stringify(
        {
          before: callerBefore,
          after: callerAfter,
          ...result.disconnectedCaller,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    clearTimeout(timer);
    release.resolve();
    caller.destroy();
    delete state.intercept;
  }
}
