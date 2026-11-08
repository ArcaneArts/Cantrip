import assert from "node:assert/strict";
import { request } from "node:http";
import { id, input } from "./computer-use-http-fixtures.mjs";
import { activityEvent } from "./computer-use-http-additional.mjs";
import { protectedInteraction } from "./agent-interaction-fixtures.mjs";
import { gate, bounded } from "./worker-log-stream-probe.mjs";
import { eventually } from "./full-worker.mjs";
import { literal } from "./project-target-state.mjs";

export async function computerUseCallerLoss({ f, state, worker, result }) {
  for (const approval of [false, true]) {
    const operation = id(approval ? 52 : 50),
      key = id(approval ? 53 : 51),
      release = gate();
    state.intercept = async (command) => {
      assert.equal(command.request.operationId, operation);
      if (approval)
        worker.notify({
          type: "computer-use.approval.terminal",
          chatId: "chat",
          requestKey: key,
          status: "interrupted",
        });
      await release.promise;
    };
    state.events = (command) =>
      approval
        ? [
            {
              type: "computer-use.approval.request",
              operationId: command.request.operationId,
              request: protectedInteraction(key, {
                projectId: "github",
                provenance: {
                  owner: "computer-use",
                  chatId: "chat",
                  workerId: "alpha",
                  threadId: null,
                  turnId: null,
                  itemId: null,
                  executionLaneId: null,
                },
                classification: { kind: "permissions" },
              }),
            },
          ]
        : [activityEvent(command.request.operationId, key)];
    const body = JSON.stringify(input(approval ? 52 : 50, "input.click")),
      client = f.client(),
      closed = gate();
    const errors = [];
    const caller = request(
      f.server.origin + "/api/chats/chat/computer-use/operation",
      {
        method: "POST",
        agent: false,
        headers: {
          origin: "http://127.0.0.1:5173",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          connection: "close",
          ...(client.cookies.size
            ? {
                cookie: [...client.cookies]
                  .map(([k, v]) => `${k}=${v}`)
                  .join("; "),
              }
            : {}),
          ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
        },
      },
    );
    caller.on("error", (error) => errors.push(error.code));
    caller.on("close", closed.resolve);
    try {
      caller.end(body);
      await eventually(
        () =>
          state.commands.some(
            (command) => command.request?.operationId === operation,
          ),
        (ready) => assert.equal(ready, true),
      );
      caller.destroy();
      await bounded(closed.promise, "destroyed CUA HTTP caller");
      assert.equal(caller.destroyed, true);
      release.resolve();
      let saved;
      await eventually(
        async () => {
          const query = approval
            ? `SELECT COALESCE((SELECT jsonb_build_object('status',status,'key',request_key,'owner',interaction_owner) FROM agent_interaction_requests WHERE request_key=${literal(key)}),'null'::jsonb)::text result`
            : `SELECT COALESCE((SELECT jsonb_build_object('id',id,'role',role,'opaque',protected_content) FROM chat_messages WHERE id=${literal(key)}),'null'::jsonb)::text result`;
          [saved] = await f.sql([], [query]);
          return saved;
        },
        (row) => {
          assert.ok(row);
          if (approval) assert.equal(row.status, "interrupted");
          else assert.equal(row.role, "assistant");
        },
      );
      (result.boundaries ??= []).push({
        approval,
        callerDestroyed: caller.destroyed,
        errors,
      });
      result.cases.push({
        name: approval
          ? "approval insert and independent terminal survive actual caller destruction"
          : "durable opaque activity survives actual caller destruction",
        saved,
      });
    } finally {
      release.resolve();
      caller.destroy();
      delete state.intercept;
      delete state.events;
    }
  }
}
