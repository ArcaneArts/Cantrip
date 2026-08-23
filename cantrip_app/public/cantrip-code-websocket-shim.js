(() => {
  const match = /^\/__cantrip_code\/([0-9a-f-]{36})\/code(?:\/|$)/iu.exec(
    location.pathname,
  );
  if (!match || window.parent === window) return;
  const adapterId = match[1];
  const NativeWebSocket = window.WebSocket;
  const sockets = new Map();

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

    constructor(url, protocols = []) {
      super();
      this.url = new URL(String(url), location.href).toString();
      this.socketId = crypto.randomUUID();
      sockets.set(this.socketId, this);
      window.parent.postMessage(
        {
          adapterId,
          protocols:
            typeof protocols === "string" ? [protocols] : [...protocols],
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
      if (data instanceof Blob) {
        this.bufferedAmount += data.size;
        void data.arrayBuffer().then((body) => {
          this.bufferedAmount = Math.max(0, this.bufferedAmount - data.size);
          this.#send(body, true);
        });
        return;
      }
      if (typeof data === "string") {
        this.#send(data, false);
        return;
      }
      const view = ArrayBuffer.isView(data)
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : data;
      this.#send(view, true);
    }

    close(code = 1000, reason = "") {
      if (this.readyState >= this.CLOSING) return;
      this.readyState = this.CLOSING;
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

    #send(data, binary) {
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

    _event(message) {
      if (message.event === "open") {
        this.readyState = this.OPEN;
        this.protocol = message.protocol ?? "";
        const event = new Event("open");
        this.dispatchEvent(event);
        this.onopen?.(event);
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
  window.__cantripNativeWebSocket = NativeWebSocket;
})();
