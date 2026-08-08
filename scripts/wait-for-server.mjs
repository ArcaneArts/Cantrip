const serverUrl =
  process.env.CANTRIP_SERVER_URL ??
  `http://${process.env.CANTRIP_SERVER_HOST ?? "127.0.0.1"}:${process.env.CANTRIP_SERVER_PORT ?? "4310"}`;
const requestedTimeoutMs = Number(
  process.env.CANTRIP_DEV_STARTUP_TIMEOUT_MS ?? 60_000,
);
const timeoutMs =
  Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
    ? requestedTimeoutMs
    : 60_000;
const deadline = Date.now() + timeoutMs;

while (Date.now() < deadline) {
  try {
    const response = await fetch(new URL("/api/health", serverUrl), {
      signal: AbortSignal.timeout(1_000),
    });
    if (response.ok) {
      process.exit(0);
    }
  } catch {
    // The server process owns the actionable startup error. Keep this gate quiet.
  }

  await new Promise((resolve) => setTimeout(resolve, 100));
}

console.error(
  `[cantrip_dev] Server did not become healthy at ${serverUrl} within ${Math.max(1, Math.ceil(timeoutMs / 1_000))} seconds.`,
);
process.exit(1);
