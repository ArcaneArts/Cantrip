(() => {
  const match = /^\/__cantrip_code\/([0-9a-f-]{36})\/code(?:\/|$)/iu.exec(
    location.pathname,
  );
  if (!match || window.parent === window) return;
  const adapterId = match[1];
  const MAX_QUEUED_SOCKET_BYTES = 8 * 1_024 * 1_024;
  const MAX_QUEUED_SOCKET_OPERATIONS = 1_024;
  const MAX_QUEUED_SESSION_BYTES = 32 * 1_024 * 1_024;
  const PROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  const blobArrayBuffer = Blob.prototype.arrayBuffer;
  const blobSize = Object.getOwnPropertyDescriptor(Blob.prototype, "size")?.get;
  const textEncoder = new TextEncoder();
  const sockets = new Map();
  let queuedSessionBytes = 0;

  const normalizeProtocols = (protocols) => {
    const normalized =
      typeof protocols === "string"
        ? [protocols]
        : Array.from(protocols, (protocol) => String(protocol));
    const seen = new Set();
    for (const protocol of normalized) {
      const identity = protocol.toLowerCase();
      if (!PROTOCOL_TOKEN.test(protocol) || seen.has(identity)) {
        throw new DOMException(
          `Invalid WebSocket subprotocol: ${JSON.stringify(protocol)}.`,
          "SyntaxError",
        );
      }
      seen.add(identity);
    }
    return normalized;
  };

  class CantripCodeWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    binaryType = "blob";
    bufferedAmount = 0;
    extensions = "";
    protocol = "";
    readyState = 0;
    onopen = null;
    onmessage = null;
    onerror = null;
    onclose = null;
    #outboundQueue = [];
    #outstandingOperations = 0;
    #processingOutbound = false;
    #sessionReservedBytes = 0;

    constructor(url, protocols = []) {
      super();
      this.url = new URL(String(url), location.href).toString();
      const normalizedProtocols = normalizeProtocols(protocols);
      this.socketId = crypto.randomUUID();
      sockets.set(this.socketId, this);
      window.parent.postMessage(
        {
          adapterId,
          protocols: normalizedProtocols,
          socketId: this.socketId,
          type: "cantrip-code-websocket-open-v1",
          url: this.url,
        },
        location.origin,
      );
    }

    send(data) {
      if (this.readyState !== this.OPEN) {
        throw new DOMException("WebSocket is not open.", "InvalidStateError");
      }
      let operation;
      if (data instanceof Blob) {
        if (!blobSize) {
          throw new DOMException(
            "Blob byte accounting is unavailable.",
            "NotSupportedError",
          );
        }
        const byteLength = blobSize.call(data);
        operation = {
          binary: true,
          byteLength,
          resolve: async () => {
            const body = await blobArrayBuffer.call(data);
            if (body.byteLength !== byteLength) {
              throw new Error("Blob byte length changed while it was queued.");
            }
            return body;
          },
        };
      } else if (typeof data === "string") {
        operation = {
          binary: false,
          byteLength: textEncoder.encode(data).byteLength,
          resolve: () => data,
        };
      } else if (ArrayBuffer.isView(data)) {
        const body = new Uint8Array(
          data.buffer,
          data.byteOffset,
          data.byteLength,
        ).slice().buffer;
        operation = {
          binary: true,
          byteLength: body.byteLength,
          resolve: () => body,
        };
      } else if (data instanceof ArrayBuffer) {
        const body = data.slice(0);
        operation = {
          binary: true,
          byteLength: body.byteLength,
          resolve: () => body,
        };
      } else {
        const body = String(data);
        operation = {
          binary: false,
          byteLength: textEncoder.encode(body).byteLength,
          resolve: () => body,
        };
      }
      if (
        this.bufferedAmount + operation.byteLength >
        MAX_QUEUED_SOCKET_BYTES
      ) {
        this.#failQueueOverflow(
          "Cantrip Code WebSocket send queue exceeded 8 MiB.",
        );
        return;
      }
      if (this.#outstandingOperations >= MAX_QUEUED_SOCKET_OPERATIONS) {
        this.#failQueueOverflow(
          "Cantrip Code WebSocket send queue exceeded 1,024 operations.",
        );
        return;
      }
      if (
        operation.byteLength >
        MAX_QUEUED_SESSION_BYTES - queuedSessionBytes
      ) {
        this.#failQueueOverflow(
          "Cantrip Code WebSocket session send queue exceeded 32 MiB.",
        );
        return;
      }
      queuedSessionBytes += operation.byteLength;
      this.#sessionReservedBytes += operation.byteLength;
      this.bufferedAmount += operation.byteLength;
      this.#outstandingOperations += 1;
      this.#outboundQueue.push(operation);
      this.#drainOutbound();
    }

    close(code = 1000, reason = "") {
      if (this.readyState >= this.CLOSING) return;
      this.readyState = this.CLOSING;
      this.#clearPendingOutbound();
      this.#releaseAllSessionBytes();
      window.parent.postMessage(
        {
          adapterId,
          code,
          reason,
          socketId: this.socketId,
          type: "cantrip-code-websocket-close-v1",
        },
        location.origin,
      );
    }

    #postSend(data, binary) {
      window.parent.postMessage(
        {
          adapterId,
          binary,
          data,
          socketId: this.socketId,
          type: "cantrip-code-websocket-send-v1",
        },
        location.origin,
      );
    }

    #drainOutbound() {
      if (this.#processingOutbound || this.readyState !== this.OPEN) return;
      const operation = this.#outboundQueue.shift();
      if (!operation) return;
      this.#processingOutbound = true;
      let result;
      try {
        result = operation.resolve();
      } catch (error) {
        this.#finishOutbound(operation, error);
        return;
      }
      if (result instanceof Promise) {
        void result.then(
          (body) => this.#finishOutbound(operation, null, body),
          (error) => this.#finishOutbound(operation, error),
        );
        return;
      }
      this.#finishOutbound(operation, null, result);
    }

    #finishOutbound(operation, error, body) {
      if (!error && this.readyState === this.OPEN) {
        try {
          this.#postSend(body, operation.binary);
        } catch (sendError) {
          error = sendError;
        }
      }
      const shouldEmitError = Boolean(error) && this.readyState === this.OPEN;
      if (error) {
        this.bufferedAmount = Math.max(
          0,
          this.bufferedAmount - operation.byteLength,
        );
        this.#outstandingOperations = Math.max(
          0,
          this.#outstandingOperations - 1,
        );
        this.#releaseSessionBytes(operation.byteLength);
      } else if (this.readyState !== this.OPEN) {
        this.bufferedAmount = Math.max(
          0,
          this.bufferedAmount - operation.byteLength,
        );
        this.#outstandingOperations = Math.max(
          0,
          this.#outstandingOperations - 1,
        );
        this.#releaseSessionBytes(operation.byteLength);
      }
      this.#processingOutbound = false;
      try {
        if (shouldEmitError) this.#emitError();
      } finally {
        this.#drainOutbound();
      }
    }

    #clearPendingOutbound() {
      let releasedBytes = 0;
      for (const operation of this.#outboundQueue)
        releasedBytes += operation.byteLength;
      const releasedOperations = this.#outboundQueue.length;
      this.#outboundQueue.length = 0;
      this.bufferedAmount = Math.max(0, this.bufferedAmount - releasedBytes);
      this.#outstandingOperations = Math.max(
        0,
        this.#outstandingOperations - releasedOperations,
      );
      this.#releaseSessionBytes(releasedBytes);
    }

    #releaseSessionBytes(byteLength) {
      const released = Math.min(byteLength, this.#sessionReservedBytes);
      this.#sessionReservedBytes -= released;
      queuedSessionBytes = Math.max(0, queuedSessionBytes - released);
    }

    #releaseAllSessionBytes() {
      this.#releaseSessionBytes(this.#sessionReservedBytes);
    }

    #emitError() {
      const event = new Event("error");
      this.dispatchEvent(event);
      this.onerror?.(event);
    }

    #failQueueOverflow(reason) {
      if (this.readyState >= this.CLOSING) return;
      this.readyState = this.CLOSED;
      this.#clearPendingOutbound();
      this.#releaseAllSessionBytes();
      sockets.delete(this.socketId);
      try {
        window.parent.postMessage(
          {
            adapterId,
            code: 1009,
            reason,
            socketId: this.socketId,
            type: "cantrip-code-websocket-close-v1",
          },
          location.origin,
        );
      } catch {
        // The socket is already terminal locally.
      }
      try {
        this.#emitError();
      } finally {
        const event = new CloseEvent("close", {
          code: 1009,
          reason,
          wasClean: false,
        });
        this.dispatchEvent(event);
        this.onclose?.(event);
      }
    }

    _event(message) {
      if (message.event === "open") {
        if (this.readyState !== this.CONNECTING) return;
        this.readyState = this.OPEN;
        this.protocol = message.protocol ?? "";
        const event = new Event("open");
        this.dispatchEvent(event);
        this.onopen?.(event);
        return;
      }
      if (message.event === "send-ack") {
        const byteLength = message.byteLength;
        if (!Number.isSafeInteger(byteLength) || byteLength < 0) return;
        this.bufferedAmount = Math.max(0, this.bufferedAmount - byteLength);
        this.#outstandingOperations = Math.max(
          0,
          this.#outstandingOperations - 1,
        );
        this.#releaseSessionBytes(byteLength);
        return;
      }
      if (message.event === "message") {
        let data = message.data;
        if (message.binary && this.binaryType === "blob")
          data = new Blob([data]);
        const event = new MessageEvent("message", {
          data,
          origin: location.origin,
        });
        this.dispatchEvent(event);
        this.onmessage?.(event);
        return;
      }
      if (message.event === "error") {
        const event = new Event("error");
        this.dispatchEvent(event);
        this.onerror?.(event);
        return;
      }
      if (message.event === "close") {
        this.readyState = this.CLOSED;
        this.#clearPendingOutbound();
        this.#releaseAllSessionBytes();
        sockets.delete(this.socketId);
        const event = new CloseEvent("close", {
          code: message.code ?? 1006,
          reason: message.reason ?? "",
          wasClean: message.wasClean ?? false,
        });
        this.dispatchEvent(event);
        this.onclose?.(event);
      }
    }
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== window.parent)
      return;
    const message = event.data;
    if (
      !message ||
      message.type !== "cantrip-code-websocket-event-v1" ||
      message.adapterId !== adapterId
    ) {
      return;
    }
    sockets.get(message.socketId)?._event(message);
  });

  Object.defineProperty(CantripCodeWebSocket, "name", { value: "WebSocket" });
  window.WebSocket = CantripCodeWebSocket;
})();
