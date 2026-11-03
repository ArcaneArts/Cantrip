// Integration: a disposable running instance, e.g. CANTRIP_OS_TEST_URL=http://127.0.0.1:6092
import assert from "node:assert/strict";
import http from "node:http";
const root = process.env.CANTRIP_OS_TEST_URL ?? "http://127.0.0.1:6081";
async function api(command, id) {
  const response = await fetch(
    `${root}/api/${command}${command === "show" ? `?id=${encodeURIComponent(id)}` : ""}`,
    ["create", "open", "restart", "stop"].includes(command)
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        }
      : {},
  );
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value;
}
function banner(token, allowed) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(
      `${root.replace(/^http/, "ws")}/websockify?token=${encodeURIComponent(token)}`,
    );
    let opened = false,
      received = false;
    const timer = setTimeout(() => {
      client.close();
      reject(new Error("WebSocket observation timed out"));
    }, 10000);
    client.onopen = () => {
      opened = true;
      if (!allowed) {
        client.close();
        clearTimeout(timer);
        reject(new Error("Stale/invalid target accepted"));
      }
    };
    client.onmessage = async (event) => {
      try {
        assert.ok(allowed);
        const data =
          typeof event.data === "string" ? event.data : await event.data.text();
        assert.match(data, /^RFB 003\.008\n/);
        received = true;
        clearTimeout(timer);
        client.close();
        resolve();
      } catch (error) {
        clearTimeout(timer);
        client.close();
        reject(error);
      }
    };
    client.onerror = () => {};
    client.onclose = () => {
      clearTimeout(timer);
      if (!allowed && !opened) resolve();
      else if (!received)
        reject(new Error("Valid target closed before its RFB banner"));
    };
  });
}
const rejectedId = `blocked-${Date.now().toString(36)}`;
for (const headers of [
  { Origin: "https://evil.invalid" },
  { Host: "evil.invalid" },
  { "Sec-Fetch-Site": "cross-site" },
]) {
  const body = JSON.stringify({ id: rejectedId });
  const status = await new Promise((resolve, reject) => {
    const outgoing = http.request(
      `${root}/api/create`,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
  assert.equal(status, 403, JSON.stringify(headers));
}
const rows = await api("list");
assert.ok(!rows.some((r) => r.id === rejectedId));
if (!rows.some((r) => r.id === "gateway-test"))
  await api("create", "gateway-test");
let record = await api("open", "gateway-test");
const old = record;
await banner(`${record.id}.${record.view_token}`, true);
await banner(`browser-b.${record.view_token}`, false);
record = await api("restart", "gateway-test");
assert.ok(record.generation > old.generation);
assert.notEqual(record.vnc_socket, old.vnc_socket);
assert.notEqual(record.view_token, old.view_token);
await banner(`${old.id}.${old.view_token}`, false);
await banner(`${record.id}.${record.view_token}`, true);
await api("stop", "gateway-test");
await banner(`${record.id}.${record.view_token}`, false);
const unknown = await fetch(`${root}/api/show?id=does-not-exist`);
assert.equal(unknown.status, 400);
console.log(
  "Local-origin controls, selected VNC target, stale generations and stopped/unknown targets: PASS",
);
