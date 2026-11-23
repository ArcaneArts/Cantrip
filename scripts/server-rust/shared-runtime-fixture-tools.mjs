import assert from "node:assert/strict";
import { appOrigin } from "./live-sockets.mjs";

export function requestHeaders(
  peer,
  { json = false, csrf = true, client: name = "main" } = {},
) {
  const client = peer.client(name);
  return {
    origin: appOrigin,
    ...(json ? { "content-type": "application/json" } : {}),
    ...(client.cookies.size
      ? { cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ") }
      : {}),
    ...(csrf && client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
  };
}
export async function request(
  peer,
  method,
  route,
  body,
  expected,
  options = {},
) {
  const response = await fetch(peer.server.origin + route, {
    method,
    headers: requestHeaders(peer, { json: body !== undefined, ...options }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  if (expected !== undefined) assert.equal(response.status, expected, text);
  if (route.startsWith("/api/"))
    assert.match(response.headers.get("x-request-id"), /^[a-f0-9-]{36}$/);
  let value = text || null;
  try {
    if (text) value = JSON.parse(text);
  } catch {}
  return { status: response.status, body: value };
}
