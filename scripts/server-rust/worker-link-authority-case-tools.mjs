import assert from "node:assert/strict";
import { eventually } from "./coordinated-fixture-tools.mjs";
export const input = (extra = {}) => ({
  ownerId: "owner",
  accountSessionId: "account",
  clientInstanceId: "client",
  workerId: "worker",
  ...extra,
});
export async function call(peer, method, fields = {}) {
  const result = await peer.call("call", { call: { method, ...fields } });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.result;
}
export async function rejected(peer, method, fields, message) {
  const result = await peer.call("call", { call: { method, ...fields } });
  assert.deepEqual(result, {
    ok: false,
    error: {
      name: "Error",
      class: "WorkerLinkUnavailableError",
      message,
      unavailable: true,
    },
  });
  return result;
}
export async function completion(peer, name) {
  const events = await eventually(
    () => peer.drain(),
    (v) => v.some((e) => e.kind === "completion" && e.name === name),
    name + " completion",
  );
  return events.find((e) => e.kind === "completion" && e.name === name).outcome;
}
export async function held(peer, command) {
  await eventually(
    () => peer.call("held", { command }),
    (v) => v === 1,
    command + " ACK held",
  );
}
export async function behavior(peer, command, value) {
  await peer.call("behavior", { command, value });
}
export async function release(peer, command) {
  assert.equal(
    await peer.call("release", {
      command,
      value: { response: { accepted: true } },
    }),
    1,
  );
}
export async function barrier(sender, receiver, target, name) {
  await sender.call("barrier", { target, name });
  await eventually(
    () => receiver.drain(),
    (v) => v.some((e) => e.kind === "barrier" && e.name === name),
    name,
  );
}
export function grant(session, extra = {}) {
  return {
    sessionId: session,
    resourceKind: "terminal",
    resourceId: "terminal",
    attachmentId: "attachment",
    lanes: ["interactive"],
    operations: ["stream:open", "stream:read", "stream:write"],
    ...extra,
  };
}
export function envelope(
  session,
  peer,
  sequence,
  sender = "client",
  extra = {},
) {
  return {
    sessionId: session,
    peerSessionId: peer,
    route: "lan",
    routeGeneration: 1,
    sender,
    signalSequence: sequence,
    signal: { type: "end-of-candidates" },
    ...extra,
  };
}
