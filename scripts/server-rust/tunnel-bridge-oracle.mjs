import { EventEmitter } from "node:events";
import { WorkerBridge } from "../../cantrip_server/src/workers/bridge.ts";
import { encodeTunnelDataPlaneFrame } from "../../packages/protocol/dist/index.js";
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
const wireSize = (value) => {
  const bytes = Buffer.byteLength(value);
  return bytes + (bytes < 126 ? 2 : bytes <= 65535 ? 4 : 10);
};
const header = {
  protocolVersion: 1,
  tunnelId: "tunnel",
  attachmentId: "attachment",
  sourceEndpointId: "desktop",
  destinationEndpointId: "worker",
  connectionId: "connection",
  sequence: 1,
  kind: "data",
  direction: "source-to-destination",
};
const payload = Uint8Array.of(1, 2, 3),
  frame = encodeTunnelDataPlaneFrame(header, payload),
  logs = [];
const bridge = new WorkerBridge(0, {
  event() {},
  rateLimited(key, level, message, context, options) {
    logs.push({ key, level, message, context, options: options ?? null });
  },
});
const offline = bridge.sendTunnelDataPlaneFrame("missing", {}, payload);
const socket = new Socket("x".repeat(8 * 1024 * 1024 - 10));
bridge.attach("worker", socket);
const bufferCurve = [
  socket.bufferedAmount,
  bridge.sendTunnelDataPlaneFrame("worker", header, payload),
  socket.bufferedAmount,
  bridge.sendTunnelDataPlaneFrame("worker", header, payload),
];
socket.release();
bufferCurve.push(
  socket.bufferedAmount,
  bridge.sendTunnelDataPlaneFrame("worker", header, payload),
  socket.bufferedAmount,
);
const forwarded = socket.release();
socket.release();
bufferCurve.push(socket.bufferedAmount);
const invalidSend = bridge.sendTunnelDataPlaneFrame(
  "worker",
  header,
  new Uint8Array(),
);
let workerLinkCallbacks = 0,
  cancelB,
  cancelC;
const trace = [],
  c = () => trace.push("C"),
  a = () => {
    trace.push("A");
    cancelB();
    cancelC ??= bridge.subscribeTunnelDataPlaneFrames("worker", c);
  };
const cancelA = bridge.subscribeTunnelDataPlaneFrames("worker", a);
cancelB = bridge.subscribeTunnelDataPlaneFrames("worker", () =>
  trace.push("B"),
);
const duplicate = bridge.subscribeTunnelDataPlaneFrames("worker", a);
const cancelLink = bridge.subscribeWorkerLinkFrames(
  "worker",
  () => workerLinkCallbacks++,
);
socket.emit("message", frame, true);
duplicate();
socket.emit("message", frame, true);
socket.emit("message", Buffer.from("CTTN"), true);
const malformedKeepsConnection = socket.readyState === 1;
const replacement = new Socket();
bridge.attach("worker", replacement);
socket.emit("message", frame, true);
replacement.emit("message", frame, true);
cancelA();
cancelC();
const cancelThrow = bridge.subscribeTunnelDataPlaneFrames("worker", () => {
  trace.push("throw");
  throw new Error("controlled callback failure");
});
const cancelAfter = bridge.subscribeTunnelDataPlaneFrames("worker", () =>
  trace.push("after"),
);
replacement.emit("message", frame, true);
cancelThrow();
replacement.emit("message", frame, true);
cancelAfter();
cancelLink();
let cancelRebind;
const nested = new Socket();
cancelRebind = bridge.subscribeTunnelDataPlaneFrames("worker", () => {
  trace.push("rebind");
  bridge.attach("worker", nested);
  trace.push("rebound");
  cancelRebind();
});
replacement.emit("message", frame, true);
nested.emit("message", frame, true);
bridge.close();
console.log(
  JSON.stringify({
    header,
    offline,
    invalidSend,
    bufferCurve,
    forwarded: Buffer.from(forwarded).toString("base64"),
    trace,
    workerLinkCallbacks,
    malformedKeepsConnection,
    logs,
  }),
);
