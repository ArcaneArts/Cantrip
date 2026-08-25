const channel = new BroadcastChannel("cantrip-code-http-v1");
const pending = new Map();
const CODE_PATH = /^\/__cantrip_code\/([0-9a-f-]{36})\/code(?:\/|$)/iu;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_HEADER_COUNT = 256;
const MAX_CONCURRENT_REQUESTS = 32;
const REQUEST_DEADLINE_MS = 30_000;
const textEncoder = new TextEncoder();
let activeRequestCount = 0;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

channel.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || message.type !== "cantrip-code-http-response-v1") return;
  const request = pending.get(message.requestId);
  if (!request || message.adapterId !== request.adapterId) return;
  request.receive(message);
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const match = CODE_PATH.exec(url.pathname);
  if (!match) return;
  event.respondWith(proxyRequest(event.request, match[1]));
});

async function proxyRequest(request, adapterId) {
  if (activeRequestCount >= MAX_CONCURRENT_REQUESTS) {
    void cancelRequestBody(request.body, "Protected Code ingress is full.");
    return textResponse(
      "Too many protected Code requests are already in progress.",
      429,
    );
  }
  activeRequestCount += 1;
  let context = null;
  try {
    const requestId = crypto.randomUUID();
    context = createRequestContext(request, adapterId, requestId);
    const body = await readRequestBody(request, context);
    context.throwIfFailed();
    const pageResponse = await deliverToPage(context, request, body);
    context.throwIfFailed();
    const response = validatePageResponse(pageResponse);
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    let responseBody = response.body;
    if (
      response.body instanceof ArrayBuffer &&
      (headers.get("content-type") ?? "").toLowerCase().includes("text/html")
    ) {
      const decoder = new TextDecoder();
      const html = decoder.decode(response.body);
      const shim = '<script src="/cantrip-code-websocket-shim.js"></script>';
      responseBody = textEncoder.encode(
        /<head(?:\s[^>]*)?>/iu.test(html)
          ? html.replace(/<head(?:\s[^>]*)?>/iu, (head) => `${head}${shim}`)
          : `${shim}${html}`,
      ).buffer;
      if (responseBody.byteLength > MAX_RESPONSE_BYTES) {
        throw new ProxyRequestError(
          "The protected Code response is too large.",
          502,
        );
      }
    }
    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    const failure =
      error instanceof ProxyRequestError
        ? error
        : new ProxyRequestError("The protected Code request failed.", 502);
    context?.fail(failure);
    return textResponse(failure.message, failure.status);
  } finally {
    context?.dispose();
    activeRequestCount -= 1;
  }
}

class ProxyRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function validatePageResponse(response) {
  if (!response || typeof response !== "object") {
    throw invalidPageResponse();
  }
  if (Object.prototype.hasOwnProperty.call(response, "error")) {
    if (typeof response.error !== "string") throw invalidPageResponse();
    throw new ProxyRequestError(response.error, 502);
  }
  if (
    !Number.isInteger(response.status) ||
    response.status < 200 ||
    response.status > 599 ||
    typeof response.statusText !== "string" ||
    /[\r\n]/u.test(response.statusText)
  ) {
    throw invalidPageResponse();
  }
  if (
    !response.headers ||
    typeof response.headers[Symbol.iterator] !== "function"
  ) {
    throw invalidPageResponse();
  }
  const headers = [];
  let headerBytes = 2;
  for (const entry of response.headers) {
    if (headers.length >= MAX_HEADER_COUNT) throw invalidPageResponse();
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw invalidPageResponse();
    }
    const [name, value] = entry;
    if (
      typeof name !== "string" ||
      typeof value !== "string" ||
      name.length > 256 ||
      value.length > 8_192 ||
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name) ||
      /[\r\n]/u.test(value)
    ) {
      throw invalidPageResponse();
    }
    headerBytes += textEncoder.encode(`${name}: ${value}\r\n`).byteLength;
    if (headerBytes > MAX_HEADER_BYTES) throw invalidPageResponse();
    headers.push([name, value]);
  }
  if (response.body !== null && !(response.body instanceof ArrayBuffer)) {
    throw invalidPageResponse();
  }
  if (response.body?.byteLength > MAX_RESPONSE_BYTES) {
    throw new ProxyRequestError(
      "The protected Code response is too large.",
      502,
    );
  }
  const bodylessStatus = [204, 205, 304].includes(response.status);
  if (bodylessStatus && response.body?.byteLength) throw invalidPageResponse();
  return {
    body: bodylessStatus ? null : response.body,
    headers,
    status: response.status,
    statusText: response.statusText,
  };
}

function invalidPageResponse() {
  return new ProxyRequestError("The protected Code response was invalid.", 502);
}

function createRequestContext(request, adapterId, requestId) {
  let cancelPosted = false;
  let delivered = false;
  let disposed = false;
  let failed = null;
  let pageReject = null;
  let pageSettled = false;
  let reader = null;
  let readerCancelled = false;

  const cancelPage = () => {
    if (!delivered || pageSettled || cancelPosted) return;
    cancelPosted = true;
    try {
      channel.postMessage({
        adapterId,
        requestId,
        type: "cantrip-code-http-cancel-v1",
      });
    } catch {
      // The request is already terminal locally. Never retry cancellation.
    }
  };
  const cancelReader = async (reason) => {
    if (!reader || readerCancelled) return;
    readerCancelled = true;
    try {
      await reader.cancel(reason);
    } catch {
      // The local failure still owns the request even if stream cancel rejects.
    }
  };
  const fail = (error) => {
    if (failed) return failed;
    failed = error;
    void cancelReader(error.message);
    cancelPage();
    if (pageReject) {
      const reject = pageReject;
      pageReject = null;
      pageSettled = true;
      if (pending.get(requestId)?.context === context)
        pending.delete(requestId);
      reject(error);
    }
    return error;
  };
  const onAbort = () =>
    fail(
      new ProxyRequestError("The protected Code request was cancelled.", 502),
    );
  const timer = setTimeout(
    () =>
      fail(new ProxyRequestError("The protected Code request timed out.", 504)),
    REQUEST_DEADLINE_MS,
  );
  const context = {
    adapterId,
    cancelReader,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      if (pending.get(requestId)?.context === context)
        pending.delete(requestId);
    },
    fail,
    markDelivered(reject) {
      delivered = true;
      pageReject = reject;
    },
    receivePageResponse() {
      pageSettled = true;
      pageReject = null;
    },
    requestId,
    setReader(nextReader) {
      reader = nextReader;
      if (failed) void cancelReader(failed.message);
    },
    clearReader(currentReader) {
      if (reader === currentReader) reader = null;
    },
    throwIfFailed() {
      if (failed) throw failed;
    },
  };
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  return context;
}

async function readRequestBody(request, context) {
  if (request.method === "GET" || request.method === "HEAD") return null;
  const declared = request.headers.get("content-length");
  const declaredLength = declared === null ? null : Number(declared);
  const reader = request.body?.getReader() ?? null;
  if (
    declaredLength !== null &&
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_REQUEST_BYTES
  ) {
    if (reader) {
      context.setReader(reader);
      void context.cancelReader("The protected Code request is too large.");
      context.clearReader(reader);
      try {
        reader.releaseLock();
      } catch {
        // Cancellation may retain the lock until its pending read settles.
      }
    }
    throw new ProxyRequestError(
      "The protected Code request is too large.",
      413,
    );
  }
  if (!reader) return null;
  context.setReader(reader);
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      context.throwIfFailed();
      const chunk = await reader.read();
      context.throwIfFailed();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        throw new ProxyRequestError(
          "The protected Code request body was invalid.",
          400,
        );
      }
      byteLength += chunk.value.byteLength;
      if (byteLength > MAX_REQUEST_BYTES) {
        void context.cancelReader("The protected Code request is too large.");
        throw new ProxyRequestError(
          "The protected Code request is too large.",
          413,
        );
      }
      chunks.push(chunk.value.slice());
    }
  } finally {
    context.clearReader(reader);
    try {
      reader.releaseLock();
    } catch {
      // A concurrently cancelled read may release its lock asynchronously.
    }
  }
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

function deliverToPage(context, request, body) {
  return new Promise((resolve, reject) => {
    context.throwIfFailed();
    const entry = {
      adapterId: context.adapterId,
      context,
      receive(message) {
        if (pending.get(context.requestId) !== entry) return;
        pending.delete(context.requestId);
        context.receivePageResponse();
        resolve(message);
      },
    };
    pending.set(context.requestId, entry);
    context.markDelivered(reject);
    try {
      channel.postMessage({
        adapterId: context.adapterId,
        body,
        headers: [...request.headers.entries()],
        method: request.method,
        requestId: context.requestId,
        type: "cantrip-code-http-request-v1",
        url: request.url,
      });
    } catch {
      const failure = new ProxyRequestError(
        "The protected Code request could not be delivered.",
        502,
      );
      context.fail(failure);
    }
  });
}

async function cancelRequestBody(body, reason) {
  if (!body) return;
  try {
    await body.cancel(reason);
  } catch {
    // The rejected request must not acquire a slot even if cancel fails.
  }
}

function textResponse(message, status) {
  return new Response(message, {
    status,
    headers: { "cache-control": "no-store", "content-type": "text/plain" },
  });
}
