# cantrip-browser

Owns a Chromium child, its private profile, and its direct DevTools connection.
The caller supplies the executable, profile path, viewport, and optional
isolated environment. The Chromium launch keeps the sandbox enabled and uses
the browser endpoint reported by that child on loopback.

Browser-level commands use the owned connection. Page commands and events
use the flattened target session. The transport limits message size, pending
requests, writes and event buffering. Callers can create isolated contexts,
dispose them, and use the target session for navigation, page evaluation and
accessibility queries.

Use the browser's asynchronous close to request an orderly exit and reap the
owned process. The result reports whether the browser exited on its own,
responded to a termination signal, or required forced cleanup. Dropping
the browser also triggers bounded process cleanup.
The worker owns higher-level surface permissions, navigation policy, and
managed runtime selection.

The worker's native health check launches the supplied executable with a
temporary profile, loads a loopback fixture, inspects accessibility, and
verifies that two browser contexts keep storage separate.

    cantrip-worker chromium-probe /path/to/chromium
