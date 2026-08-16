(() => {
  const relayState = globalThis;
  if (relayState.__CANTRIP_CLIENT_LOG_NATIVE_RELAY_INSTALLED__) return;
  relayState.__CANTRIP_CLIENT_LOG_NATIVE_RELAY_INSTALLED__ = true;

  const maxMessageLength = 16_384;
  const maxSourceLength = 2_048;
  const originalConsole = {
    debug: console.debug.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    log: console.log.bind(console),
    trace: console.trace.bind(console),
    warn: console.warn.bind(console),
  };

  const serialize = (value, seen = new WeakSet()) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) {
      return `${value.name}: ${value.message}`;
    }
    if (typeof value === "bigint") return `${value.toString()}n`;
    if (typeof value === "symbol" || typeof value === "function") {
      return String(value);
    }
    if (value === undefined) return "undefined";
    try {
      return (
        JSON.stringify(value, (_key, item) => {
          if (item instanceof Error) {
            return {
              message: item.message,
              name: item.name,
            };
          }
          if (typeof item === "bigint") return `${item.toString()}n`;
          if (typeof item === "object" && item !== null) {
            if (seen.has(item)) return "[Circular]";
            seen.add(item);
          }
          return item;
        }) ?? String(value)
      );
    } catch {
      try {
        return String(value);
      } catch {
        return "[Unserializable value]";
      }
    }
  };

  const secretName = (value) =>
    /^(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|password|passwd|passphrase|secret|client[-_]?secret|api[-_]?key|apikey|token|access[-_]?token|refresh[-_]?token|id[-_]?token|provider[-_]?token|private[-_]?key|credential|csrf(?:[-_]?token)?|xsrf[-_]?token|device[-_]?code|oauth[-_]?code|pairing[-_]?code|enrollment[-_]?code|signed[-_]?url)$/iu.test(
      value,
    );

  const sanitizeUrl = (candidate) => {
    try {
      const url = new URL(candidate);
      if (url.username || url.password) {
        url.username = "redacted";
        url.password = "redacted";
      }
      for (const key of [...url.searchParams.keys()]) {
        if (secretName(key)) url.searchParams.set(key, "[REDACTED]");
      }
      return url.toString();
    } catch {
      return candidate;
    }
  };

  const sanitizeText = (value) =>
    value
      .replace(
        /(?:\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f])/gu,
        "",
      )
      .replace(
        /\bauthorization(\s*[=:]\s*)(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu,
        (_match, separator) => `Authorization${separator}[REDACTED]`,
      )
      .replace(
        /\b(authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|password|passwd|passphrase|secret|client[_-]?secret|api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|id[_-]?token|provider[_-]?token|private[_-]?key|credential|csrf(?:[_-]?token)?|xsrf[_-]?token|device[_-]?code|oauth[_-]?code|pairing[_-]?code|enrollment[_-]?code|signed[_-]?url)(["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/giu,
        (_match, name, separator) => `${name}${separator}"[REDACTED]"`,
      )
      .replace(
        /\b(?:sk|gh[opusr]|xox[baprs]|pat)[-_][A-Za-z0-9_-]{8,}\b/gu,
        "[REDACTED]",
      )
      .replace(/https?:\/\/[^\s"'<>]+/giu, sanitizeUrl);

  const format = (values) => {
    const message = values.map((value) => serialize(value)).join(" ");
    const sanitized = sanitizeText(message);
    if (sanitized.length <= maxMessageLength) return sanitized;
    return `${sanitized.slice(0, maxMessageLength)}… [truncated]`;
  };

  const callerSource = () => {
    const stack = new Error().stack;
    if (!stack) return undefined;
    const frame = stack
      .split("\n")
      .map((line) => line.trim())
      .find(
        (line, index) =>
          index > 1 &&
          !line.includes("callerSource") &&
          !line.includes("relayClientLog") &&
          !line.includes("console.<computed>"),
      );
    return frame?.slice(0, maxSourceLength);
  };

  const relayClientLog = (level, values, source) => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== "function") return;
    const safeSource =
      typeof source === "string"
        ? sanitizeText(source).slice(0, maxSourceLength)
        : undefined;
    try {
      void Promise.resolve(
        invoke("relay_client_log", {
          level,
          message: format(values),
          source: safeSource,
        }),
      ).catch(() => {
        // Do not log relay failures through the wrapped console and recurse.
      });
    } catch {
      // Logging must never disrupt the client code it is observing.
    }
  };

  const requestDetails = (input, init) => {
    const requestUrl =
      typeof input === "string" || input instanceof URL ? input : input.url;
    let source = String(requestUrl);
    try {
      const redacted = new URL(source, window.location.href);
      redacted.username = "";
      redacted.password = "";
      redacted.search = "";
      redacted.hash = "";
      source = redacted.toString();
    } catch {
      source = "unparseable client URL";
    }
    const method =
      init?.method ??
      (typeof Request !== "undefined" && input instanceof Request
        ? input.method
        : "GET");
    return { method: method.toUpperCase(), source };
  };

  for (const level of Object.keys(originalConsole)) {
    console[level] = (...values) => {
      const sanitized = format(values);
      originalConsole[level](sanitized);
      relayClientLog(level, [sanitized], callerSource());
    };
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const request = requestDetails(args[0], args[1]);
    try {
      const response = await originalFetch(...args);
      if (!response.ok) {
        relayClientLog(
          response.status >= 500 ? "error" : "warn",
          [`Fetch ${request.method} returned ${response.status}`],
          request.source,
        );
      }
      return response;
    } catch (error) {
      relayClientLog(
        "error",
        [`Fetch ${request.method} failed`, error],
        request.source,
      );
      throw error;
    }
  };

  window.addEventListener(
    "error",
    (event) => {
      if (event instanceof ErrorEvent) {
        relayClientLog(
          "error",
          ["Uncaught client error", event.error ?? event.message],
          event.filename
            ? `${event.filename}:${event.lineno}:${event.colno}`
            : undefined,
        );
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) return;
      const url = target.getAttribute("src") ?? target.getAttribute("href");
      relayClientLog(
        "error",
        [`Failed to load client resource <${target.tagName.toLowerCase()}>`],
        url ?? window.location.href,
      );
    },
    true,
  );

  window.addEventListener("unhandledrejection", (event) => {
    relayClientLog(
      "error",
      ["Unhandled client promise rejection", event.reason],
      callerSource(),
    );
  });

  window.addEventListener("securitypolicyviolation", (event) => {
    relayClientLog(
      "error",
      [
        `Content Security Policy blocked ${event.violatedDirective || "a client resource"}`,
      ],
      event.blockedURI || event.sourceFile || window.location.href,
    );
  });

  window.addEventListener("messageerror", () => {
    relayClientLog(
      "error",
      ["Client message could not be deserialized"],
      window.location.href,
    );
  });

  relayClientLog(
    "debug",
    ["Client console relay connected"],
    window.location.href,
  );
})();
