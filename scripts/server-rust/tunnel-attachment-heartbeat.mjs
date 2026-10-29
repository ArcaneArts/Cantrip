// Use the production 25s/10s timers and real ping/pong control frames.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { until } from "./tunnel-attachment-probe.mjs";
export async function tunnelAttachmentHeartbeat({
  attachment,
  ready,
  saved,
  result,
}) {
  let probe = await ready("matching heartbeat token", attachment, {
    autoPong: false,
  });
  await until(() => probe.pings.length, "production heartbeat interval", 30000);
  const token = probe.pings[0];
  assert.equal(token.length, 16);
  probe.socket.pong(token);
  await delay(11000);
  assert.equal(
    probe.closed,
    undefined,
    "matching token keeps attachment active beyond timeout",
  );
  await saved("matching pong keeps attachment", probe);
  probe = await ready("wrong heartbeat token", attachment, { autoPong: false });
  await until(
    () => probe.pings.length,
    "next production heartbeat interval",
    30000,
  );
  const wrong = Buffer.from(probe.pings[0]);
  assert.equal(wrong.length, 16);
  wrong[0] ^= 1;
  probe.socket.pong(wrong);
  await until(
    () => probe.closed,
    "wrong token does not postpone heartbeat timeout",
    15000,
  );
  assert.deepEqual(probe.closed, {
    code: 1012,
    reason: "Attachment heartbeat timed out",
  });
  await saved("wrong pong expires attachment", probe);
  result.heartbeat = {
    realTimers: true,
    tokenBytes: 16,
    matchingTokenSurvivesTimeout: true,
    wrongTokenCloses: true,
  };
}
