const channel = new BroadcastChannel("cantrip-code-http-v1");
const pending = new Map();
const CODE_PATH = /^\/__cantrip_code\/([0-9a-f-]{36})\/code(?:\/|$)/iu;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

channel.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || message.type !== "cantrip-code-http-response-v1") return;
  const request = pending.get(message.requestId);
  if (!request) return;
  pending.delete(message.requestId);
  clearTimeout(request.timer);
  request.resolve(message);
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const match = CODE_PATH.exec(url.pathname);
  if (!match) return;
  event.respondWith(proxyRequest(event.request, match[1]));
});

async function proxyRequest(request, adapterId) {
  const requestId = crypto.randomUUID();
  let body = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.arrayBuffer();
  }
  const response = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({
        error: "The protected Code request timed out.",
        requestId,
        type: "cantrip-code-http-response-v1",
      });
    }, 60_000);
    pending.set(requestId, { resolve, timer });
    channel.postMessage({
      adapterId,
      body,
      headers: [...request.headers.entries()],
      method: request.method,
      requestId,
      type: "cantrip-code-http-request-v1",
      url: request.url,
    });
  });
  if (response.error) {
    return new Response(response.error, {
      status: 502,
      headers: { "cache-control": "no-store", "content-type": "text/plain" },
    });
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  let responseBody = response.body;
  if ((headers.get("content-type") ?? "").toLowerCase().includes("text/html")) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const html = decoder.decode(response.body);
    const shim = '<script src="/cantrip-code-websocket-shim.js"></script>';
    responseBody = encoder.encode(
      /<head(?:\s[^>]*)?>/iu.test(html)
        ? html.replace(/<head(?:\s[^>]*)?>/iu, (head) => `${head}${shim}`)
        : `${shim}${html}`,
    ).buffer;
  }
  return new Response(responseBody, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
