// Record only protocol and timing metadata for a failed browser scope refresh.
import { performance } from "node:perf_hooks";

export function observeFolderLive(page, serverOrigin) {
  const records = [];
  const started = performance.now();
  const record = (kind, fields) => {
    records.push({
      atMs: Math.round(performance.now() - started),
      kind,
      ...fields,
    });
    if (records.length > 80) records.shift();
  };
  const isProjectSnapshot = (request) => {
    const url = new URL(request.url());
    return (
      url.origin === serverOrigin &&
      url.pathname === "/api/projects" &&
      request.method() === "GET"
    );
  };
  const projectRequests = new WeakMap();
  let requestSequence = 0;
  page.on("request", (request) => {
    if (!isProjectSnapshot(request)) return;
    const id = ++requestSequence;
    projectRequests.set(request, id);
    record("projects-request", { id });
  });
  page.on("response", (response) => {
    const id = projectRequests.get(response.request());
    if (id) record("projects-response", { id, status: response.status() });
  });
  page.on("requestfailed", (request) => {
    const id = projectRequests.get(request);
    if (id) record("projects-request-failed", { id });
  });
  let socketSequence = 0;
  page.on("websocket", (socket) => {
    const url = new URL(socket.url());
    const httpOrigin = url.origin.replace(/^ws/, "http");
    if (httpOrigin !== serverOrigin || url.pathname !== "/api/live") return;
    const socketId = ++socketSequence;
    record("socket-open", { socketId });
    socket.on("close", () => record("socket-close", { socketId }));
    socket.on("socketerror", () => record("socket-error", { socketId }));
    for (const [event, direction] of [
      ["framesent", "send"],
      ["framereceived", "receive"],
    ]) {
      socket.on(event, ({ payload }) => {
        try {
          const frame = JSON.parse(payload.toString());
          if (
            typeof frame?.type !== "string" ||
            !/^[a-z-]{1,32}$/u.test(frame.type)
          )
            return;
          const cursor = frame.cursor ?? frame.currentCursor;
          record("socket-frame", {
            socketId,
            direction,
            type: frame.type,
            cursor: Number.isSafeInteger(cursor) ? cursor : undefined,
            scopeCount: Array.isArray(frame.scopes)
              ? frame.scopes.length
              : undefined,
          });
        } catch {
          record("socket-frame-unparsed", { socketId, direction });
        }
      });
    }
  });
  return (snapshot) => ({
    snapshot: snapshot && {
      status: snapshot.status,
      activeScopeCount: snapshot.activeScopeCount,
      desiredScopeCount: snapshot.desiredScopeCount,
      lastCursor: snapshot.lastCursor,
      reconnectAttempt: snapshot.reconnectAttempt,
      hasLastError: snapshot.lastError !== null,
    },
    records: [...records],
  });
}
