// Test oracle: the actual Node service, listening on an OS-assigned port.
import { buildApp } from "../../cantrip_server/src/app.ts";
import { readServerConfig } from "../../cantrip_server/src/config.ts";
import { connectDatabase } from "../../cantrip_server/src/db/index.ts";
import { WorkerBridge } from "../../cantrip_server/src/workers/bridge.ts";
import { installWorkerIngressFixture } from "./worker-ingress-node-fixture.mjs";
import { startOperationClock } from "./operation-clock.mjs";

const config = readServerConfig();
const database = await connectDatabase(config);
const drainAuthNotifications = process.argv.includes(
  "--drain-auth-notifications",
);
const observeAudits = process.argv.includes("--observe-audits");
const notifications = new Set();
const repositoryOperations = new Set();
if (drainAuthNotifications || observeAudits) {
  const wrappers = new WeakMap();
  database.repository = new Proxy(database.repository, {
    get(target, key) {
      const method = Reflect.get(target, key, target);
      if (typeof method !== "function") return method;
      if (!wrappers.has(method))
        wrappers.set(method, (...args) => {
          const result = Reflect.apply(method, target, args);
          if (
            result &&
            typeof result.then === "function" &&
            (drainAuthNotifications || key === "appendAuditEvent")
          ) {
            // Assimilate a lazy thenable once; tracking and returning the
            // original builder could otherwise execute its query twice.
            const pending = Promise.resolve(result);
            if (drainAuthNotifications) {
              repositoryOperations.add(pending);
              pending.then(
                () => repositoryOperations.delete(pending),
                () => repositoryOperations.delete(pending),
              );
            }
            if (observeAudits && key === "appendAuditEvent") {
              const input = args[0];
              const receipt = (ok) =>
                diagnose("fixture.audit.completed", {
                  requestId: input.requestId,
                  action: input.action,
                  ownerId: input.ownerId ?? null,
                  ok,
                });
              pending.then(
                () => receipt(true),
                () => receipt(false),
              );
            }
            return pending;
          }
          return result;
        });
      return wrappers.get(method);
    },
  });
}
const diagnose = (event, details = {}) =>
  console.error(JSON.stringify({ event, ...details }));
const closeDatabase = database.close.bind(database);
database.close = async () => {
  if (drainAuthNotifications) {
    // The original PGlite fixture can deadlock if close races a notification's
    // transaction after bridge shutdown. This opt-in oracle plumbing retains
    // the real source consumer and awaits its actual promise; the unmodified
    // baseline failures are retained separately. Rust uses its production drain.
    diagnose("fixture.auth-notifications.draining", {
      active: notifications.size,
    });
    while (notifications.size || repositoryOperations.size)
      await Promise.allSettled([...notifications, ...repositoryOperations]);
  }
  diagnose("fixture.database.closing");
  await closeDatabase();
  diagnose("fixture.database.closed");
};
const ingressFixture = process.argv.includes("--worker-ingress-fixture");
const ingressBridge =
  ingressFixture || drainAuthNotifications ? new WorkerBridge() : undefined;
if (drainAuthNotifications) {
  const subscribe = ingressBridge.subscribeNotifications.bind(ingressBridge);
  const wrappers = new WeakMap();
  ingressBridge.subscribeNotifications = (worker, listener) => {
    if (!wrappers.has(listener))
      wrappers.set(listener, (notification) => {
        const pending = Promise.resolve(listener(notification));
        notifications.add(pending);
        pending.then(
          () => notifications.delete(pending),
          () => notifications.delete(pending),
        );
        return pending;
      });
    return subscribe(worker, wrappers.get(listener));
  };
}
const app = await buildApp({
  config,
  database,
  logger: false,
  ...(ingressBridge ? { workerBridge: ingressBridge } : {}),
});
if (process.argv.includes("--observe-http-clocks")) {
  const clocks = new WeakMap();
  app.addHook("onRequest", (request, _reply, done) => {
    clocks.set(request, startOperationClock());
    done();
  });
  app.addHook("onResponse", (request, _reply, done) => {
    diagnose("fixture.http.clock", {
      requestId: request.id,
      operationClock: clocks.get(request)?.(),
    });
    done();
  });
}
if (observeAudits) {
  // Observe the actual source hooks after their writes; no replacement handler,
  // altered response or synthetic completion delay is installed.
  app.addHook("onResponse", async (request) => {
    diagnose("fixture.response.completed", {
      requestId: request.id,
      ownerId:
        request.principal.state === "authenticated"
          ? request.principal.user.id
          : null,
    });
  });
}
const closeIngress = ingressFixture
  ? installWorkerIngressFixture(app, ingressBridge)
  : undefined;
const sockets = new Set();
app.server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});
app.server.once("close", () => diagnose("fixture.http.closed"));
app.addHook("preClose", async () => diagnose("fixture.pre-close"));
app.addHook("onClose", async () => diagnose("fixture.on-close.started"));
const origin = await app.listen({ host: "127.0.0.1", port: 0 });
console.log(JSON.stringify({ event: "server.listening", origin }));

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const snapshot = (event) =>
    diagnose(event, {
      sockets: [...sockets].map((socket) => ({
        state: socket.readyState,
        destroyed: socket.destroyed,
        readable: socket.readable,
        writable: socket.writable,
      })),
      websocketStates: [...app.websocketServer.clients].map(
        (socket) => socket.readyState,
      ),
      resources: process.getActiveResourcesInfo(),
    });
  snapshot("fixture.shutdown.started");
  const timer = setInterval(() => snapshot("fixture.shutdown.pending"), 5000);
  timer.unref();
  try {
    closeIngress?.();
    await app.close();
    snapshot("fixture.shutdown.completed");
  } finally {
    clearInterval(timer);
  }
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
process.stdin.once("end", () => void stop());
process.stdin.resume();
