(() => {
  function cantripCodeBlobWorkerBootstrap(config) {
    const bufferedEvents = [];
    let buffering = true;
    let registration = null;
    const nativeFetch = globalThis.fetch?.bind(globalThis);

    const bufferEvent = (event) => {
      if (!buffering) return;
      event.stopImmediatePropagation();
      bufferedEvents.push({
        data: event.data,
        lastEventId: event.lastEventId,
        origin: event.origin,
        ports: Array.from(event.ports ?? []),
        source: event.source,
        type: event.type,
      });
    };
    self.addEventListener("message", bufferEvent);
    self.addEventListener("connect", bufferEvent);

    const delay = (duration) =>
      new Promise((resolve) => setTimeout(resolve, duration));

    const registerOnce = async () => {
      if (!nativeFetch) return false;
      try {
        const response = await nativeFetch(
          `${config.origin}/__cantrip_code/${config.adapterId}/code/__cantrip_client_register_v2`,
          {
            cache: "no-store",
            credentials: "same-origin",
            headers: {
              "x-cantrip-code-frame-nonce": config.frameNonce,
              "x-cantrip-code-generation": config.generation,
              "x-cantrip-code-lineage-token": config.lineageToken,
            },
            method: "POST",
          },
        );
        return response.status === 204;
      } catch {
        return false;
      }
    };

    const respondToLineageChallenge = (event) => {
      const container = navigator.serviceWorker;
      const message = event.data;
      if (
        !container?.controller ||
        event.source !== container.controller ||
        message?.type !== "cantrip-code-client-lineage-challenge-v2" ||
        message.adapterId !== config.adapterId ||
        message.generation !== config.generation ||
        message.frameNonce !== config.frameNonce ||
        typeof message.challenge !== "string"
      ) {
        return;
      }
      container.controller.postMessage({
        adapterId: config.adapterId,
        challenge: message.challenge,
        frameNonce: config.frameNonce,
        generation: config.generation,
        lineageToken: config.lineageToken,
        type: "cantrip-code-client-lineage-response-v2",
      });
    };

    const ensureRegistered = () => {
      if (registration) return registration;
      registration = (async () => {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if (await registerOnce()) return;
          await delay(Math.min(250, 25 * (attempt + 1)));
        }
        throw new Error("Cantrip Code blob worker authorization timed out.");
      })().finally(() => {
        registration = null;
      });
      return registration;
    };

    const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
    const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    const knownBlobUrls = new Map();
    const sharedWorkerWrappers = new Map();
    URL.createObjectURL = (object) => {
      const url = nativeCreateObjectURL(object);
      if (object instanceof Blob) knownBlobUrls.set(url, object);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      knownBlobUrls.delete(String(url));
      nativeRevokeObjectURL(url);
    };

    const wrapConstructor = (NativeConstructor, constructorName) => {
      function CantripCodeWorker(url, options) {
        if (!new.target) {
          throw new TypeError(`${constructorName} constructor requires 'new'.`);
        }
        const originalUrl = String(url);
        let protectedWorker = false;
        try {
          const parsed = new URL(originalUrl, config.origin);
          protectedWorker =
            parsed.origin === config.origin &&
            new RegExp(
              `^/__cantrip_code/${config.adapterId}/code(?:/|$)`,
              "iu",
            ).test(parsed.pathname);
        } catch {
          // The native constructor owns ordinary URL validation.
        }
        if (!originalUrl.startsWith("blob:") && !protectedWorker) {
          return new NativeConstructor(url, options);
        }
        const shared = constructorName === "SharedWorker";
        const cacheKey = `${originalUrl}:${options?.type === "module" ? "module" : "classic"}`;
        const cachedWrapper = sharedWorkerWrappers.get(cacheKey);
        if (shared && cachedWrapper) {
          return new NativeConstructor(cachedWrapper, options);
        }
        const originalBlob = knownBlobUrls.get(originalUrl);
        const importUrl = originalBlob
          ? nativeCreateObjectURL(originalBlob)
          : originalUrl;
        const source = `(${cantripCodeBlobWorkerBootstrap.toString()})(${JSON.stringify(
          {
            ...config,
            module: options?.type === "module",
            originalUrl: importUrl,
            revokeOriginalUrl: Boolean(originalBlob) && !shared,
          },
        )});`;
        const wrapperUrl = nativeCreateObjectURL(
          new Blob([source], { type: "application/javascript" }),
        );
        if (shared) sharedWorkerWrappers.set(cacheKey, wrapperUrl);
        try {
          return new NativeConstructor(wrapperUrl, options);
        } finally {
          if (!shared) nativeRevokeObjectURL(wrapperUrl);
        }
      }
      CantripCodeWorker.prototype = NativeConstructor.prototype;
      Object.setPrototypeOf(CantripCodeWorker, NativeConstructor);
      Object.defineProperty(CantripCodeWorker, "name", {
        value: constructorName,
      });
      return CantripCodeWorker;
    };

    const installNestedWorkerWrappers = () => {
      if (typeof globalThis.Worker === "function") {
        globalThis.Worker = wrapConstructor(globalThis.Worker, "Worker");
      }
      if (typeof globalThis.SharedWorker === "function") {
        globalThis.SharedWorker = wrapConstructor(
          globalThis.SharedWorker,
          "SharedWorker",
        );
      }
    };

    const replayBufferedEvents = () => {
      buffering = false;
      self.removeEventListener("message", bufferEvent);
      self.removeEventListener("connect", bufferEvent);
      for (const event of bufferedEvents) {
        self.dispatchEvent(
          new MessageEvent(event.type, {
            data: event.data,
            lastEventId: event.lastEventId,
            origin: event.origin,
            ports: event.ports,
            source: event.source,
          }),
        );
      }
      bufferedEvents.length = 0;
    };

    void (async () => {
      const container = navigator.serviceWorker;
      await ensureRegistered();
      if (container?.addEventListener) {
        container.addEventListener("message", respondToLineageChallenge);
        container.addEventListener("controllerchange", () => {
          void ensureRegistered().catch(() => undefined);
        });
      }
      installNestedWorkerWrappers();
      if (nativeFetch) {
        globalThis.fetch = (...args) =>
          ensureRegistered().then(() => nativeFetch(...args));
      }
      try {
        if (config.module) await import(config.originalUrl);
        else importScripts(config.originalUrl);
      } finally {
        if (config.revokeOriginalUrl) {
          nativeRevokeObjectURL(config.originalUrl);
        }
      }
      replayBufferedEvents();
    })().catch((error) => {
      setTimeout(() => {
        throw error;
      });
    });
  }

  const match = /^\/__cantrip_code\/([0-9a-f-]{36})\/code(?:\/|$)/iu.exec(
    location.pathname,
  );
  if (!match || window.top === window) return;
  const adapterId = match[1];
  const relayWindow = window.top;
  if (!relayWindow) return;
  const MAX_QUEUED_SOCKET_BYTES = 8 * 1_024 * 1_024;
  const MAX_QUEUED_SOCKET_OPERATIONS = 1_024;
  const MAX_QUEUED_SESSION_BYTES = 32 * 1_024 * 1_024;
  const PROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  const blobArrayBuffer = Blob.prototype.arrayBuffer;
  const blobSize = Object.getOwnPropertyDescriptor(Blob.prototype, "size")?.get;
  const textEncoder = new TextEncoder();
  const sockets = new Map();
  let queuedSessionBytes = 0;

  const lineageContent =
    typeof document === "undefined"
      ? null
      : document
          .querySelector('meta[name="cantrip-code-worker-lineage"]')
          ?.getAttribute("content");
  const lineageMatch =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([A-Za-z0-9_-]{16,128}):([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu.exec(
      lineageContent ?? "",
    );
  if (lineageMatch) {
    const config = {
      adapterId,
      frameNonce: lineageMatch[2],
      generation: lineageMatch[1],
      lineageToken: lineageMatch[3],
      origin: location.origin,
    };
    const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
    const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    const knownBlobUrls = new Map();
    const sharedWorkerWrappers = new Map();
    URL.createObjectURL = (object) => {
      const url = nativeCreateObjectURL(object);
      if (object instanceof Blob) knownBlobUrls.set(url, object);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      knownBlobUrls.delete(String(url));
      nativeRevokeObjectURL(url);
    };
    const serviceWorkerContainer = navigator.serviceWorker;
    if (serviceWorkerContainer?.addEventListener) {
      serviceWorkerContainer.addEventListener("message", (event) => {
        const message = event.data;
        if (
          event.source !== serviceWorkerContainer.controller ||
          message?.type !== "cantrip-code-client-lineage-challenge-v2" ||
          message.adapterId !== config.adapterId ||
          message.generation !== config.generation ||
          message.frameNonce !== config.frameNonce ||
          typeof message.challenge !== "string"
        ) {
          return;
        }
        serviceWorkerContainer.controller?.postMessage({
          adapterId: config.adapterId,
          challenge: message.challenge,
          frameNonce: config.frameNonce,
          generation: config.generation,
          lineageToken: config.lineageToken,
          type: "cantrip-code-client-lineage-response-v2",
        });
      });
    }
    const wrapConstructor = (NativeConstructor, constructorName) => {
      function CantripCodeWorker(url, options) {
        if (!new.target) {
          throw new TypeError(`${constructorName} constructor requires 'new'.`);
        }
        const originalUrl = String(url);
        let protectedWorker = false;
        try {
          const parsed = new URL(originalUrl, config.origin);
          protectedWorker =
            parsed.origin === config.origin &&
            new RegExp(
              `^/__cantrip_code/${config.adapterId}/code(?:/|$)`,
              "iu",
            ).test(parsed.pathname);
        } catch {
          // The native constructor owns ordinary URL validation.
        }
        if (!originalUrl.startsWith("blob:") && !protectedWorker) {
          return new NativeConstructor(url, options);
        }
        const shared = constructorName === "SharedWorker";
        const cacheKey = `${originalUrl}:${options?.type === "module" ? "module" : "classic"}`;
        const cachedWrapper = sharedWorkerWrappers.get(cacheKey);
        if (shared && cachedWrapper) {
          return new NativeConstructor(cachedWrapper, options);
        }
        const originalBlob = knownBlobUrls.get(originalUrl);
        const importUrl = originalBlob
          ? nativeCreateObjectURL(originalBlob)
          : originalUrl;
        const source = `(${cantripCodeBlobWorkerBootstrap.toString()})(${JSON.stringify(
          {
            ...config,
            module: options?.type === "module",
            originalUrl: importUrl,
            revokeOriginalUrl: Boolean(originalBlob) && !shared,
          },
        )});`;
        const wrapperUrl = nativeCreateObjectURL(
          new Blob([source], { type: "application/javascript" }),
        );
        if (shared) sharedWorkerWrappers.set(cacheKey, wrapperUrl);
        try {
          return new NativeConstructor(wrapperUrl, options);
        } finally {
          if (!shared) nativeRevokeObjectURL(wrapperUrl);
        }
      }
      CantripCodeWorker.prototype = NativeConstructor.prototype;
      Object.setPrototypeOf(CantripCodeWorker, NativeConstructor);
      Object.defineProperty(CantripCodeWorker, "name", {
        value: constructorName,
      });
      return CantripCodeWorker;
    };
    if (typeof window.Worker === "function") {
      window.Worker = wrapConstructor(window.Worker, "Worker");
    }
    if (typeof window.SharedWorker === "function") {
      window.SharedWorker = wrapConstructor(
        window.SharedWorker,
        "SharedWorker",
      );
    }
    let lineageAccepted = false;
    let lineageAttempts = 0;
    let lineageTimer = null;
    const postLineage = () => {
      if (lineageAccepted || lineageAttempts >= 20) {
        if (lineageTimer !== null) clearInterval(lineageTimer);
        lineageTimer = null;
        return;
      }
      lineageAttempts += 1;
      relayWindow.postMessage(
        {
          adapterId: config.adapterId,
          frameNonce: config.frameNonce,
          generation: config.generation,
          lineageToken: config.lineageToken,
          type: "cantrip-code-worker-lineage-v2",
        },
        location.origin,
      );
    };
    window.addEventListener("message", (event) => {
      if (event.origin !== location.origin || event.source !== relayWindow)
        return;
      const message = event.data;
      if (
        message?.adapterId !== adapterId ||
        message.frameNonce !== config.frameNonce ||
        message.generation !== config.generation
      ) {
        return;
      }
      if (message.type === "cantrip-code-worker-lineage-accepted-v2") {
        lineageAccepted = true;
        if (lineageTimer !== null) clearInterval(lineageTimer);
        lineageTimer = null;
      } else if (message.type === "cantrip-code-worker-lineage-request-v2") {
        lineageAttempts = 0;
        postLineage();
      }
    });
    postLineage();
    if (!lineageAccepted) lineageTimer = setInterval(postLineage, 250);
  }

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
      relayWindow.postMessage(
        {
          adapterId,
          frameNonce: lineageMatch?.[2],
          generation: lineageMatch?.[1],
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
      relayWindow.postMessage(
        {
          adapterId,
          code,
          frameNonce: lineageMatch?.[2],
          generation: lineageMatch?.[1],
          reason,
          socketId: this.socketId,
          type: "cantrip-code-websocket-close-v1",
        },
        location.origin,
      );
    }

    #postSend(data, binary) {
      relayWindow.postMessage(
        {
          adapterId,
          binary,
          data,
          frameNonce: lineageMatch?.[2],
          generation: lineageMatch?.[1],
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
        relayWindow.postMessage(
          {
            adapterId,
            code: 1009,
            frameNonce: lineageMatch?.[2],
            generation: lineageMatch?.[1],
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
    if (event.origin !== location.origin || event.source !== relayWindow)
      return;
    const message = event.data;
    if (
      !message ||
      message.type !== "cantrip-code-websocket-event-v1" ||
      message.adapterId !== adapterId ||
      message.generation !== lineageMatch?.[1] ||
      message.frameNonce !== lineageMatch?.[2]
    ) {
      return;
    }
    sockets.get(message.socketId)?._event(message);
  });

  Object.defineProperty(CantripCodeWebSocket, "name", { value: "WebSocket" });
  window.WebSocket = CantripCodeWebSocket;
})();
