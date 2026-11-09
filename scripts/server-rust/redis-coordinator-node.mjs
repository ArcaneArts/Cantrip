// Test plumbing invokes the production coordinator; it does not reimplement it.
import { RedisRelayCoordinator } from "../../tests/reference-node-server/src/coordination/relay-coordinator.ts";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";

let coordinator;
const events = [];
const record = (event) => events.push(event);
function message(value) {
  const copy = structuredClone(value);
  if (
    typeof copy.payloadBase64 === "string" &&
    copy.payloadBase64.length > 4096
  ) {
    copy.payloadBase64 = {
      bytes: Buffer.byteLength(value.payloadBase64),
      sha256: createHash("sha256").update(value.payloadBase64).digest("hex"),
    };
  }
  return copy;
}
async function dispatch(r) {
  switch (r.op) {
    case "init":
      coordinator = new RedisRelayCoordinator(r.options);
      coordinator.subscribe((value) =>
        record({ kind: "message", value: message(value) }),
      );
      await coordinator.start();
      return null;
    case "start":
      await coordinator.start();
      return null;
    case "close":
      await coordinator.close();
      return null;
    case "events":
      return events.splice(0);
    case "stats":
      return coordinator.stats();
    case "health":
      return coordinator.health();
    case "cachedWorker":
      return coordinator.cachedWorker(r.workerId);
    case "findWorker":
      return coordinator.findWorker(r.workerId);
    case "claimWorker":
      return coordinator.claimWorker(r.input);
    case "refreshWorker":
      return coordinator.refreshWorker(r.workerId, r.connectionId);
    case "releaseWorker":
      return coordinator.releaseWorker(r.workerId, r.connectionId);
    case "findSession":
      return coordinator.findWorkerLinkSession(r.sessionId);
    case "claimSession":
      return coordinator.claimWorkerLinkSession(r.claim);
    case "refreshSession":
      return coordinator.refreshWorkerLinkSession(r.claim);
    case "releaseSession":
      return coordinator.releaseWorkerLinkSession(
        r.sessionId,
        r.authorityInstanceId,
      );
    case "publish":
      await coordinator.publish(r.payload, r.ttl);
      return null;
    case "blockingListener": {
      let unblock;
      const blocked = new Promise((resolve) => {
        unblock = resolve;
      });
      coordinator.subscribe(async (value) => {
        if (value.kind === "await-next") {
          record({ kind: "blocked" });
          await blocked;
          record({ kind: "resumed" });
        }
        if (value.kind === "unblock") {
          record({ kind: "unblock" });
          unblock();
        }
      });
      return null;
    }
    case "mutatingListeners": {
      let remove;
      const late = () => record({ kind: "late" });
      coordinator.subscribe((value) => {
        if (value.kind !== "mutate-listeners") return;
        remove();
        coordinator.subscribe(late);
      });
      remove = coordinator.subscribe(() => record({ kind: "removed" }));
      return null;
    }
    case "failingListener":
      coordinator.subscribe((value) => {
        if (value.kind === "listener-error")
          throw new Error("Controlled callback failure");
      });
      coordinator.subscribe((value) => {
        if (value.kind === "listener-error") record({ kind: "after-error" });
      });
      return null;
    default:
      throw new Error(`Unknown fixture operation: ${r.op}`);
  }
}
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  try {
    const result = await dispatch(request);
    process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ id: request.id, error: error.message })}\n`,
    );
  }
}
await coordinator?.close();
