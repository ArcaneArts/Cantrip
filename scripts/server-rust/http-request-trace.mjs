// Opt-in test evidence from actual HTTP clients. Never record credentials,
// request/response bodies or query values, and never consume response streams.
import { channel } from "node:diagnostics_channel";
import { writeFileSync } from "node:fs";
import { isMainThread } from "node:worker_threads";

let context = {};
const origins = new Map();
export function setHttpTraceContext(value) {
  context = { ...value };
}
export function registerHttpTraceOrigin(origin, value) {
  const target = address(origin, "/");
  if (target.origin) origins.set(target.origin, { ...value });
}

function address(origin, path) {
  try {
    const url = new URL(path, origin);
    return { origin: url.origin, path: url.pathname };
  } catch {
    // Observing a malformed request must not prevent its actual attempt.
    return { origin: null, path: null };
  }
}

export function traceHttpRequests() {
  const requests = [],
    seen = new WeakMap(),
    subscriptions = [],
    upgrades = new Map();
  let active = true;
  const get = (request, client) => {
    if (!seen.has(request)) {
      const origin =
        client === "fetch"
          ? String(request.origin)
          : `${request.protocol}//${request.getHeader("host")}`;
      const target = address(origin, request.path);
      const value = {
        index: requests.length,
        client,
        context: { ...(origins.get(target.origin) ?? context) },
        method: request.method,
        ...target,
        status: null,
      };
      seen.set(request, value);
      requests.push(value);
    }
    return seen.get(request);
  };
  const subscribe = (name, listener) => {
    const source = channel(name);
    source.subscribe(listener);
    subscriptions.push(() => source.unsubscribe(listener));
  };
  const forgetUpgrade = (request) => {
    const listener = upgrades.get(request);
    if (listener) request.off("upgrade", listener);
    upgrades.delete(request);
  };
  subscribe("undici:request:create", ({ request }) => {
    if (active) get(request, "fetch");
  });
  subscribe("undici:request:headers", ({ request, response }) => {
    if (active) get(request, "fetch").status = response.statusCode;
  });
  subscribe("undici:request:error", ({ request, error }) => {
    if (active)
      get(request, "fetch").error = { name: error.name, code: error.code };
  });
  subscribe("http.client.request.start", ({ request }) => {
    if (!active) return;
    const value = get(request, "http");
    // Node decides upgrade ownership from the presence of an upgrade listener.
    // Observe only already-owned upgrades; do not accept an otherwise unhandled
    // 101 or add any response/data/error listener to ordinary requests.
    if (request.listenerCount("upgrade") > 0) {
      const upgraded = (response) => {
        if (active) value.status = response.statusCode;
        upgrades.delete(request);
      };
      request.once("upgrade", upgraded);
      upgrades.set(request, upgraded);
    }
  });
  subscribe("http.client.response.finish", ({ request, response }) => {
    if (active) get(request, "http").status = response.statusCode;
    forgetUpgrade(request);
  });
  subscribe("http.client.request.error", ({ request, error }) => {
    if (active)
      get(request, "http").error = { name: error.name, code: error.code };
    forgetUpgrade(request);
  });
  return {
    requests,
    close() {
      active = false;
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
      for (const [request, listener] of upgrades)
        request.off("upgrade", listener);
      upgrades.clear();
      return requests;
    },
  };
}

const destination = process.env.CANTRIP_RUST_HTTP_TRACE_FILE;
if (destination && isMainThread && !process.env.CANTRIP_RUST_HTTP_TRACE_OWNER) {
  process.env.CANTRIP_RUST_HTTP_TRACE_OWNER = String(process.pid);
  const trace = traceHttpRequests();
  process.once("exit", (exitCode) =>
    writeFileSync(
      destination,
      JSON.stringify(
        {
          schemaVersion: 1,
          pid: process.pid,
          node: process.version,
          exitCode,
          requests: trace.close(),
        },
        null,
        2,
      ) + "\n",
    ),
  );
}
