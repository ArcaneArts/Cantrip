// Observe only the disposable worker's first scheduled occurrence.
import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const file = process.env.CANTRIP_TEST_AUTOMATION_DISPATCH;
if (
  file &&
  process.argv[1] === process.env.CANTRIP_TEST_AUTOMATION_WORKER_ENTRY
) {
  const request = globalThis.fetch;
  const { WebSocket } = createRequire(process.argv[1])("ws");
  const emit = WebSocket.prototype.emit;
  const send = WebSocket.prototype.send;
  let occurrence,
    matchingReply,
    raced = false;

  const save = (name, value) => {
    writeFileSync(file + "." + name + ".tmp", JSON.stringify(value));
    renameSync(file + "." + name + ".tmp", file + "." + name);
  };

  globalThis.fetch = function (input, init) {
    if (
      !occurrence &&
      input instanceof URL &&
      init?.method === "POST" &&
      existsSync(file + ".armed")
    ) {
      const { id, otherOrigin, phase } = JSON.parse(
        readFileSync(file + ".armed", "utf8"),
      );
      if (
        input.pathname === `/api/internal/workers/automations/${id}/dispatch`
      ) {
        const owner = new URL(process.env.CANTRIP_SERVER_URL);
        const other = new URL(otherOrigin);
        assert.equal(input.origin, owner.origin);
        assert.equal(owner.hostname, "127.0.0.1");
        assert.equal(other.hostname, "127.0.0.1");
        assert.notEqual(other.origin, owner.origin);
        occurrence = {
          id,
          phase,
          // The second request is the same enrolled worker and occurrence on
          // the other local peer. Credentials stay inside this test process.
          compete: async () => {
            const response = await request(
              new URL(input.pathname + input.search, other),
              {
                ...init,
                signal: AbortSignal.timeout(5000),
              },
            );
            const body = await response.json();
            save("contender", {
              httpStatus: response.status,
              accepted: body.accepted,
              status: body.status,
            });
          },
        };
      }
    }
    return request(input, init);
  };

  WebSocket.prototype.emit = function (event, ...args) {
    if (
      occurrence &&
      !matchingReply &&
      event === "message" &&
      String(args[0]).startsWith("{")
    ) {
      const frame = JSON.parse(String(args[0]));
      if (
        frame.kind === "request" &&
        frame.command?.type === "automation.dispatch.protect" &&
        frame.command.automationId === occurrence.id
      )
        matchingReply = { requestId: frame.requestId, socket: this };
    }
    return emit.call(this, event, ...args);
  };

  WebSocket.prototype.send = function (data, ...args) {
    if (
      !raced &&
      matchingReply?.socket === this &&
      typeof data === "string" &&
      data.startsWith("{")
    ) {
      const frame = JSON.parse(data);
      if (
        frame.kind === "response" &&
        frame.requestId === matchingReply.requestId &&
        frame.ok === true &&
        frame.result?.allowed === true
      ) {
        raced = true;
        save("protected", { requestId: frame.requestId, allowed: true });
        void occurrence
          .compete()
          .catch((error) => save("contender", { errorType: error.name }))
          .finally(() => {
            if (occurrence.phase === "finish") send.call(this, data, ...args);
          });
        return;
      }
    }
    return send.call(this, data, ...args);
  };
}
