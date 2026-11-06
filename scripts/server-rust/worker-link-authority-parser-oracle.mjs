// Development oracle: execute the verbatim reference service helpers. No
// production TypeScript file is changed and no reference condition is replaced.
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { transformSync } from "esbuild";
import * as protocol from "../../packages/protocol/dist/worker-link.js";
import { workerLinkWireFixtures } from "./worker-link-wire-fixtures.mjs";

const source = await readFile(
  new URL("../../cantrip_server/src/worker-links/service.ts", import.meta.url),
  "utf8",
);
const constants = source.match(/^const MAX_ERROR_LENGTH = .*;$/m)[0];
const helpers = source.slice(source.indexOf("function claimFor("));
const javascript = transformSync(constants + "\n" + helpers, {
  loader: "ts",
  target: "es2022",
}).code;
const reference = vm.runInNewContext(
  javascript +
    "\n({parseOperation,parseRevokeScope,parseRelayRevokeScope,boundedError})",
  { ...protocol },
);
const cases = [];
function observe(kind, input) {
  let result;
  try {
    result = { ok: true, value: reference[kind](input) };
  } catch (error) {
    result = { ok: false, error: error.message };
  }
  cases.push({ kind, input, result });
}
const peerInput =
  workerLinkWireFixtures.workerLinkPeerSessionOpenRequestSchema.find(
    (v) => protocol.workerLinkPeerSessionOpenRequestSchema.safeParse(v).success,
  );
const envelope = workerLinkWireFixtures.workerLinkPeerSignalEnvelopeSchema.find(
  (v) => protocol.workerLinkPeerSignalEnvelopeSchema.safeParse(v).success,
);
const mailbox =
  workerLinkWireFixtures.workerLinkPeerMailboxReadRequestSchema.find(
    (v) => protocol.workerLinkPeerMailboxReadRequestSchema.safeParse(v).success,
  );
const operations = [
  { kind: "renew-session", sessionId: "session" },
  { kind: "replace-route", sessionId: "session", preferredRoute: "relay" },
  { kind: "open-peer", sessionId: "session", input: peerInput },
  { kind: "signal-peer", sessionId: envelope.sessionId, envelope },
  {
    kind: "read-peer-mailbox",
    sessionId: "session",
    peerSessionId: "peer",
    input: mailbox,
  },
  { kind: "revoke-peer", sessionId: "session", peerSessionId: "peer" },
  { kind: "issue-grant", input: { sessionId: "session", unknown: true } },
  { kind: "renew-grant", sessionId: "session", grantId: "grant" },
  {
    kind: "revoke-grant",
    sessionId: "session",
    grantId: "grant",
    reason: "released",
  },
  { kind: "revoke-session", sessionId: "session", reason: "server-shutdown" },
];
const values = [
  null,
  false,
  true,
  0,
  1,
  "",
  "x",
  [],
  {},
  ["relay"],
  ["released"],
  { toString: "blocked" },
  "x".repeat(200),
  "x".repeat(201),
  "😀".repeat(100),
  "😀".repeat(101),
  "\ud800",
];
for (const operation of operations) {
  observe("parseOperation", operation);
  observe("parseOperation", { ...operation, extra: { opaque: true } });
  for (const key of [
    "kind",
    "sessionId",
    "preferredRoute",
    "input",
    "envelope",
    "peerSessionId",
    "grantId",
    "reason",
  ]) {
    if (!Object.hasOwn(operation, key)) continue;
    const missing = { ...operation };
    delete missing[key];
    observe("parseOperation", missing);
    for (const value of values)
      observe("parseOperation", { ...operation, [key]: value });
  }
}
for (const input of values) observe("parseOperation", input);
for (const kind of ["resource", "attachment"]) {
  for (const resourceKind of [
    "terminal",
    "tunnel",
    "project-share",
    "browser",
    "remote-desktop",
    "observations",
    "other",
    ["terminal"],
    null,
  ]) {
    const scope = {
      kind,
      ownerId: "owner",
      resourceKind,
      resourceId: "resource",
      attachmentId: "attachment",
      reason: "resource-stopped",
      extra: "retained",
    };
    observe("parseRevokeScope", scope);
    for (const key of [
      "kind",
      "ownerId",
      "resourceId",
      "attachmentId",
      "reason",
    ]) {
      const missing = { ...scope };
      delete missing[key];
      observe("parseRevokeScope", missing);
      for (const value of values)
        observe("parseRevokeScope", { ...scope, [key]: value });
    }
  }
}
for (const scope of [
  { kind: "owner", ownerId: "owner" },
  { kind: "account-session", accountSessionId: "account" },
  { kind: "session", sessionId: "session" },
]) {
  for (const operation of ["parseRevokeScope", "parseRelayRevokeScope"]) {
    observe(operation, scope);
    for (const key of Object.keys(scope)) {
      const missing = { ...scope };
      delete missing[key];
      observe(operation, missing);
      for (const value of values)
        observe(operation, { ...scope, [key]: value });
    }
  }
}
for (const value of [
  "",
  "a".repeat(499),
  "a".repeat(500),
  "a".repeat(501),
  "😀".repeat(251),
  "a".repeat(499) + "😀",
  "\ud800".repeat(501),
  "line\n\0".repeat(101),
])
  observe("boundedError", value);
console.log(
  JSON.stringify({ suite: "verbatim-worker-link-service-helpers", cases }),
);
