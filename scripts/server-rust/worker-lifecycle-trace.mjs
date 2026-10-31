// Test-only preload: observe handles that retain a full worker after shutdown.
// Unreferenced diagnostic timers do not extend the process lifetime.
import { createHook } from "node:async_hooks";
const kill = process.kill;
process.kill = function (pid, signal) {
  try {
    return kill.call(process, pid, signal);
  } finally {
    if (signal && signal !== 0)
      console.error(
        JSON.stringify({
          event: "test.worker.process.signal",
          workerPid: process.pid,
          targetPid: pid,
          signal,
          stack: new Error().stack?.split("\n").slice(2, 8),
        }),
      );
  }
};
const resources = new Map();
const tracked = new Set([
  "Timeout",
  "TCPWRAP",
  "TLSWRAP",
  "PROCESSWRAP",
  "GETADDRINFOREQWRAP",
  "FSEVENTWRAP",
]);
let ending = false;
createHook({
  init(id, type, _trigger, resource) {
    if (!tracked.has(type)) return;
    resources.set(id, {
      type,
      createdDuringShutdown: ending,
      resource: new WeakRef(resource),
      stack: new Error().stack?.split("\n").slice(2, 12),
    });
  },
  destroy(id) {
    resources.delete(id);
  },
}).enable();
process.on("SIGTERM", () => {
  if (ending) return;
  ending = true;
  for (const delay of [2000, 10000])
    setTimeout(() => {
      const active = [];
      for (const [id, value] of resources) {
        const resource = value.resource.deref();
        if (
          resource &&
          resource.hasRef?.() !== false &&
          !value.stack?.some((line) =>
            line.includes("worker-lifecycle-trace.mjs"),
          )
        )
          active.push({
            id,
            type: value.type,
            createdDuringShutdown: value.createdDuringShutdown,
            referenced: resource.hasRef?.(),
            stack: value.stack,
          });
      }
      const handles = process.report
        .getReport()
        .libuv.filter((handle) => handle.is_active || handle.is_referenced);
      console.error(
        JSON.stringify({
          event: "test.worker.shutdown.handles",
          pid: process.pid,
          delayMs: delay,
          resourceTypes: process.getActiveResourcesInfo(),
          handles,
          resources: active.slice(-40),
        }),
      );
    }, delay).unref();
});
