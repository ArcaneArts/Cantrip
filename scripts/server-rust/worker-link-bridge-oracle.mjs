import { EventEmitter } from "node:events";
import { WorkerBridge } from "../../cantrip_server/src/workers/bridge.ts";
import { createWorkerLinkFrame } from "../../packages/protocol/dist/worker-link.js";
import { workerLinkWireFixtures } from "./worker-link-wire-fixtures.mjs";
class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  constructor(ready) {
    super();
    this.ready = ready;
  }
  publishReady() {
    if (this.ready) this.send(this.ready);
    return true;
  }
  send(value) {
    this.sent.push(value);
    this.bufferedAmount += wireSize(value);
  }
  release() {
    const value = this.sent.shift();
    this.bufferedAmount -= wireSize(value);
    return value;
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
}
const header = workerLinkWireFixtures.workerLinkFrameHeaderSchema.find(
  (v) => v.kind === "data",
);
const frame = createWorkerLinkFrame(header, Uint8Array.of(1, 2, 3));
const bridge = new WorkerBridge(0, { event() {}, rateLimited() {} });
const wireSize = (value) => {
  const bytes = Buffer.byteLength(value);
  return bytes + (bytes < 126 ? 2 : bytes <= 65535 ? 4 : 10);
};
const socket = new Socket("x".repeat(8 * 1024 * 1024 - 10));
bridge.attach("worker", socket);
const bufferCurve = [
  socket.bufferedAmount,
  bridge.sendWorkerLinkFrame("worker", frame),
  socket.bufferedAmount,
  bridge.sendWorkerLinkFrame("worker", frame),
];
socket.release();
bufferCurve.push(
  socket.bufferedAmount,
  bridge.sendWorkerLinkFrame("worker", frame),
  socket.bufferedAmount,
);
const forwarded = socket.release();
socket.release();
bufferCurve.push(socket.bufferedAmount);
const trace = [];
let cancelB, cancelC;
const c = () => trace.push("C");
const a = () => {
  trace.push("A");
  cancelB();
  cancelC ??= bridge.subscribeWorkerLinkFrames("worker", c);
};
const cancelA = bridge.subscribeWorkerLinkFrames("worker", a);
cancelB = bridge.subscribeWorkerLinkFrames("worker", () => trace.push("B"));
const duplicate = bridge.subscribeWorkerLinkFrames("worker", a);
socket.emit("message", frame.bytes, true);
duplicate();
socket.emit("message", frame.bytes, true);
socket.emit("message", Buffer.from("CWLK"), true);
const malformedKeepsConnection = socket.readyState === 1;
const replacement = new Socket();
bridge.attach("worker", replacement);
socket.emit("message", frame.bytes, true);
replacement.emit("message", frame.bytes, true);
cancelA();
cancelC();
const cancelThrow = bridge.subscribeWorkerLinkFrames("worker", () => {
  trace.push("throw");
  throw new Error("controlled callback failure");
});
const cancelAfter = bridge.subscribeWorkerLinkFrames("worker", () =>
  trace.push("after"),
);
replacement.emit("message", frame.bytes, true);
cancelThrow();
replacement.emit("message", frame.bytes, true);
cancelAfter();
bridge.close();
console.log(
  JSON.stringify({
    header,
    payload: [1, 2, 3],
    forwarded: Buffer.from(forwarded).toString("base64"),
    bufferCurve,
    trace,
    malformedKeepsConnection,
  }),
);
