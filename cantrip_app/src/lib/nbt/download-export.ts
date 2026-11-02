import type { NbtExportSink, OpenNbtExportSink } from "./export-copy";

async function activated(worker: ServiceWorker, signal: AbortSignal) {
  if (worker.state === "activated") return;
  await new Promise<void>((resolve, reject) => {
    const changed = () => {
      if (worker.state === "activated") {
        cleanup();
        resolve();
      } else if (worker.state === "redundant") {
        cleanup();
        reject(new Error("The browser download worker stopped."));
      }
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => {
      worker.removeEventListener("statechange", changed);
      signal.removeEventListener("abort", aborted);
    };
    worker.addEventListener("statechange", changed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    else changed();
  });
}

/** Same-origin streaming download for browsers without a destination writer.
 * The service worker receives one bounded page per consumer pull and persists
 * nothing. Completion means browser consumption, not an OS durability receipt. */
export const openDownloadNbtExport: OpenNbtExportSink = async (
  name,
  signal,
) => {
  const registration = await navigator.serviceWorker.register(
    "/cantrip-nbt-export-worker.js",
    { scope: "/cantrip-exports/" },
  );
  signal.throwIfAborted();
  const worker =
    registration.active ?? registration.waiting ?? registration.installing;
  if (!worker)
    throw new Error("The browser did not start its download worker.");
  await activated(worker, signal);
  signal.throwIfAborted();
  const channel = new MessageChannel(),
    port = channel.port1,
    frame = document.createElement("iframe"),
    id = crypto.randomUUID();
  frame.hidden = true;
  frame.title = "NBT export download";
  let closed = false,
    failure: unknown,
    demand: number | undefined,
    pull:
      | { resolve(sequence: number): void; reject(error: unknown): void }
      | undefined,
    ack:
      | { sequence: number; resolve(): void; reject(error: unknown): void }
      | undefined,
    ready!: () => void,
    rejectReady!: (error: unknown) => void,
    finish: { resolve(): void; reject(error: unknown): void } | undefined;
  const opening = new Promise<void>((resolve, reject) => {
    ready = resolve;
    rejectReady = reject;
  });
  const cleanup = () => {
    signal.removeEventListener("abort", aborted);
    frame.remove();
    port.close();
  };
  const fail = (error: unknown) => {
    if (closed) return;
    closed = true;
    failure = error;
    port.postMessage({ type: "abort" });
    rejectReady(error);
    pull?.reject(error);
    ack?.reject(error);
    finish?.reject(error);
    pull = undefined;
    ack = undefined;
    finish = undefined;
    cleanup();
  };
  const aborted = () =>
    fail(signal.reason ?? new Error("NBT export cancelled."));
  port.onmessageerror = () =>
    fail(new Error("The browser download channel failed."));
  port.onmessage = ({ data }) => {
    if (closed) return;
    if (data?.type === "ready") ready();
    else if (
      data?.type === "pull" &&
      Number.isSafeInteger(data.sequence) &&
      data.sequence > 0
    ) {
      if (demand !== undefined) {
        fail(new Error("The download requested overlapping pages."));
        return;
      }
      if (pull) {
        const selected = pull;
        pull = undefined;
        selected.resolve(data.sequence);
      } else demand = data.sequence;
    } else if (
      data?.type === "consumed" &&
      ack &&
      ack.sequence === data.sequence
    ) {
      const selected = ack;
      ack = undefined;
      selected.resolve();
    } else if (data?.type === "closed" && finish) {
      closed = true;
      const selected = finish;
      finish = undefined;
      cleanup();
      selected.resolve();
    } else
      fail(
        new Error(
          data?.type === "failed" && typeof data.message === "string"
            ? data.message
            : "The browser download stream failed.",
        ),
      );
  };
  signal.addEventListener("abort", aborted, { once: true });
  try {
    worker.postMessage({ type: "nbt.export", version: 1, id, name }, [
      channel.port2,
    ]);
    if (signal.aborted) aborted();
    await opening;
  } catch (error) {
    fail(error);
    throw error;
  }
  frame.src = "/cantrip-exports/" + id;
  document.body.append(frame);
  const next = () => {
    if (closed)
      return Promise.reject(failure ?? new Error("The download is closed."));
    if (demand !== undefined) {
      const sequence = demand;
      demand = undefined;
      return Promise.resolve(sequence);
    }
    return new Promise<number>((resolve, reject) => {
      pull = { resolve, reject };
    });
  };
  return {
    completion:
      "Copy sent to browser downloads. The original draft is retained.",
    async write(bytes) {
      const sequence = await next();
      if (closed) throw failure ?? new Error("The download is closed.");
      const consumed = new Promise<void>((resolve, reject) => {
        ack = { sequence, resolve, reject };
      });
      const copy = bytes.slice();
      port.postMessage({ type: "bytes", sequence, bytes: copy }, [copy.buffer]);
      await consumed;
    },
    async close() {
      const sequence = await next();
      if (closed) throw failure ?? new Error("The download is closed.");
      const complete = new Promise<void>((resolve, reject) => {
        finish = { resolve, reject };
      });
      port.postMessage({ type: "end", sequence });
      await complete;
    },
    async abort(reason) {
      fail(reason);
    },
  } satisfies NbtExportSink;
};
