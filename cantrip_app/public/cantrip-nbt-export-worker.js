/* One-use, in-memory download streams. No caches, OPFS, network uploads, or
 * decrypted document snapshots are used by this worker. */
const streams = new Map();
self.addEventListener("install", (event) =>
  event.waitUntil(self.skipWaiting()),
);
self.addEventListener("message", (event) => {
  const value = event.data,
    port = event.ports[0];
  if (
    !port ||
    value?.type !== "nbt.export" ||
    value.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    typeof value.name !== "string" ||
    value.name.length > 1024 ||
    !event.source ||
    new URL(event.source.url).origin !== self.location.origin
  )
    return;
  if (streams.has(value.id)) {
    port.close();
    return;
  }
  let finish;
  const settled = new Promise((resolve) => {
    finish = resolve;
  });
  const entry = {
    port,
    name: value.name,
    finish,
    controller: null,
    pending: null,
    sequence: 0,
    closed: false,
  };
  const end = (error) => {
    if (entry.closed) return;
    entry.closed = true;
    streams.delete(value.id);
    if (error) {
      entry.controller?.error(new Error(error));
      port.postMessage({ type: "failed", message: error });
    } else port.postMessage({ type: "closed" });
    entry.pending?.();
    entry.pending = null;
    finish();
    port.close();
    entry.name = "";
    entry.controller = null;
  };
  entry.end = end;
  port.onmessageerror = () => end("The download channel failed.");
  port.onmessage = ({ data }) => {
    if (data?.type === "abort") {
      end("The download was cancelled.");
      return;
    }
    if (entry.closed || !entry.pending || data?.sequence !== entry.sequence) {
      end("The download stream changed sequence.");
      return;
    }
    if (data.type === "end") {
      entry.controller.close();
      end();
      return;
    }
    if (
      data.type !== "bytes" ||
      !(data.bytes instanceof Uint8Array) ||
      !data.bytes.length ||
      data.bytes.length > 256 * 1024
    ) {
      end("The download chunk is invalid or oversized.");
      return;
    }
    const resolve = entry.pending;
    entry.pending = null;
    entry.controller.enqueue(data.bytes);
    port.postMessage({ type: "consumed", sequence: entry.sequence });
    resolve();
  };
  streams.set(value.id, entry);
  port.postMessage({ type: "ready" });
  // The export has an explicit Cancel action. Its lifetime is the actual
  // response stream, not a heartbeat or a quota/size prediction.
  event.waitUntil(settled);
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin !== self.location.origin ||
    !url.pathname.startsWith("/cantrip-exports/")
  )
    return;
  const id = url.pathname.slice("/cantrip-exports/".length),
    entry = streams.get(id);
  if (event.request.method !== "GET" || !entry || entry.closed) {
    event.respondWith(
      new Response("This export is unavailable.", { status: 404 }),
    );
    return;
  }
  streams.delete(id);
  const body = new ReadableStream(
    {
      start(controller) {
        entry.controller = controller;
      },
      pull() {
        return new Promise((resolve) => {
          if (entry.closed) {
            resolve();
            return;
          }
          entry.pending = resolve;
          entry.port.postMessage({ type: "pull", sequence: ++entry.sequence });
        });
      },
      cancel() {
        entry.end("The browser cancelled the download.");
      },
    },
    { highWaterMark: 0 },
  );
  const encoded = encodeURIComponent(entry.name).replace(
    /['()*]/g,
    (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
  );
  event.respondWith(
    new Response(body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition":
          "attachment; filename=\"document.nbt\"; filename*=UTF-8''" + encoded,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    }),
  );
});
