import assert from "node:assert/strict";
import http from "node:http";

const compared = [
  "upgrade",
  "connection",
  "sec-websocket-accept",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
  "content-type",
  "content-length",
  "cache-control",
  "set-cookie",
  "x-request-id",
  "content-security-policy",
  "access-control-allow-origin",
];
function request(fixture, changes, method = "GET") {
  return new Promise((resolve, reject) => {
    const headers = {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
      ...changes,
    };
    for (const [name, value] of Object.entries(headers))
      if (value === null) delete headers[name];
    const req = http.request(
      `${fixture.server.origin}/api/internal/workers/connect?workerId=fixture-worker&connectionGeneration=99999999-9999-4999-8999-999999999999`,
      { method, headers },
    );
    const timer = setTimeout(
      () => req.destroy(new Error("Handshake fixture timed out")),
      15000,
    );
    const result = (response, body) => {
      clearTimeout(timer);
      const selected = Object.fromEntries(
        compared.map((name) => [name, response.headers[name] ?? null]),
      );
      // HTTP/1.1 persistence is implicit when Connection is absent. Preserve
      // close/Upgrade exactly, comparing explicit and implicit keep-alive as
      // the same transport behavior.
      if (
        response.statusCode !== 101 &&
        selected.connection === null &&
        response.httpVersion === "1.1"
      )
        selected.connection = "keep-alive";
      if (selected["x-request-id"]) {
        assert.match(selected["x-request-id"], /^[0-9a-f-]{36}$/);
        selected["x-request-id"] = "<request-id>";
      }
      resolve({ status: response.statusCode, headers: selected, body });
    };
    req.once("upgrade", (response, socket) => {
      socket.destroy();
      result(response, "");
    });
    req.once("response", (response) => {
      const chunks = [];
      response.on("data", (bytes) => chunks.push(bytes));
      response.on("end", () =>
        result(response, Buffer.concat(chunks).toString()),
      );
    });
    req.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end();
  });
}
export async function workerHandshakes(fixture) {
  const cases = [];
  for (const [label, changes, method] of [
    ["HTTP/1 websocket 13", {}],
    ["HTTP/1 websocket 8", { "sec-websocket-version": "8" }],
    ["JavaScript decimal version", { "sec-websocket-version": "1.3e1" }],
    ["JavaScript hexadecimal version", { "sec-websocket-version": "0xd" }],
    ["invalid version", { "sec-websocket-version": "7" }],
    ["missing version", { "sec-websocket-version": null }],
    ["empty version", { "sec-websocket-version": "" }],
    ["multiple versions", { "sec-websocket-version": "13, 8" }],
    ["missing key", { "sec-websocket-key": null }],
    ["malformed key", { "sec-websocket-key": "invalid" }],
    [
      "noncanonical key accepted by ws",
      { "sec-websocket-key": "AAAAAAAAAAAAAAAAAAAAAB==" },
    ],
    ["empty subprotocol", { "sec-websocket-protocol": "" }],
    ["duplicate subprotocol", { "sec-websocket-protocol": "one, one" }],
    ["subprotocol trailing separator", { "sec-websocket-protocol": "one," }],
    ["subprotocol leading separator", { "sec-websocket-protocol": ",one" }],
    [
      "subprotocol whitespace inside token",
      { "sec-websocket-protocol": "o ne" },
    ],
    [
      "case-sensitive subprotocol uniqueness",
      { "sec-websocket-protocol": "One, one" },
    ],
    [
      "subprotocol optional whitespace",
      { "sec-websocket-protocol": "one,\t two" },
    ],
    [
      "v2 preferred over v1",
      {
        "sec-websocket-protocol":
          "unknown, cantrip-worker-auth-ready-v1, cantrip-worker-auth-ready-v2",
      },
    ],
    ["unused malformed extension ignored", { "sec-websocket-extensions": "=" }],
    ["upgrade header case", { upgrade: "WebSocket" }],
    ["invalid upgrade header", { upgrade: "invalid" }],
    ["missing upgrade header", { upgrade: null }],
    ["missing Connection header", { connection: null }],
    ["Connection with multiple tokens", { connection: "keep-alive, Upgrade" }],
    ["incorrect HTTP method", {}, "POST"],
  ])
    cases.push({ label, ...(await request(fixture, changes, method)) });
  return { passed: true, cases };
}
