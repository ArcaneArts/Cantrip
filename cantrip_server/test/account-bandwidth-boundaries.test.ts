import { PassThrough, Readable } from "node:stream";

import {
  appLiveClientMessageSchema,
  workerResponseEnvelopeSchema,
  type AppLiveClientMessage,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import type {
  AccountUsageMeasurement,
  AccountUsageRecorder,
} from "../src/account-usage/bandwidth-meter.js";
import {
  encodedPayloadBytes,
  meterPayloadStream,
} from "../src/account-usage/http-bandwidth.js";
import { AppLiveHub, type AppLiveSocket } from "../src/live/hub.js";
import { WorkerBridge, type WorkerSocket } from "../src/workers/bridge.js";
import { MeteredWorkerCommandBus } from "../src/workers/metered-command-bus.js";

class RecordingMeter implements AccountUsageRecorder {
  readonly measurements: AccountUsageMeasurement[] = [];
  record(measurement: AccountUsageMeasurement): boolean {
    this.measurements.push(measurement);
    return true;
  }
}

class TestLiveSocket implements AppLiveSocket {
  bufferedAmount = 0;
  readyState = 1;
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Array<(...args: never[]) => void>>();
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  on(event: string, listener: (...args: never[]) => void): void {
    const values = this.listeners.get(event) ?? [];
    values.push(listener);
    this.listeners.set(event, values);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...(args as never[]));
    }
  }
  receive(message: AppLiveClientMessage): void {
    this.emit(
      "message",
      JSON.stringify(appLiveClientMessageSchema.parse(message)),
      false,
    );
  }
}

class TestWorkerSocket implements WorkerSocket {
  bufferedAmount = 0;
  readyState = 1;
  readonly sent: Array<string | Uint8Array> = [];
  readonly listeners = new Map<string, Array<(...args: never[]) => void>>();
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  on(event: string, listener: (...args: never[]) => void): void {
    const values = this.listeners.get(event) ?? [];
    values.push(listener);
    this.listeners.set(event, values);
  }
  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...(args as never[]));
    }
  }
}

describe("account bandwidth network boundaries", () => {
  it("counts HTTP buffers and completed or aborted streams", async () => {
    const meter = new RecordingMeter();
    expect(encodedPayloadBytes('{"ok":true}')).toBe(11);
    expect(encodedPayloadBytes(Buffer.from("abc"))).toBe(3);

    const completed = meterPayloadStream(
      Readable.from(["hello", Buffer.from("!")]),
      "owner-1",
      "ingress",
      meter,
    );
    let body = "";
    for await (const chunk of completed) body += chunk.toString();
    expect(body).toBe("hello!");

    const source = new PassThrough();
    const aborted = meterPayloadStream(source, "owner-1", "egress", meter);
    aborted.resume();
    source.write("part");
    aborted.destroy();
    source.destroy();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(
      meter.measurements
        .filter((item) => item.direction === "ingress")
        .reduce((total, item) => total + Number(item.bytes), 0),
    ).toBe(6);
    expect(
      meter.measurements.filter(
        (item) => item.channel === "http" && item.operationCount === 1,
      ),
    ).toHaveLength(2);
  });

  it("meters live text frames once and suppresses accounting invalidation feedback", async () => {
    const meter = new RecordingMeter();
    const hub = new AppLiveHub({
      epoch: "usage-live",
      usageRecorder: meter,
    });
    const socket = new TestLiveSocket();
    hub.attach(socket, {
      ownerId: "owner-1",
      authorizeScope: () => true,
    });
    socket.receive({
      type: "initialize",
      protocolVersion: 1,
      client: {
        id: "client-1",
        name: "Client",
        version: "1",
        controlCapabilities: [],
      },
      resume: null,
    });
    socket.receive({
      type: "subscribe",
      requestId: "subscribe-1",
      scopes: [{ kind: "current-user" }],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    meter.measurements.length = 0;

    hub.publish({
      ownerId: "owner-1",
      scope: { kind: "current-user" },
      resource: "account-resource-usage",
      action: "updated",
      entityId: null,
      revision: 1,
      payload: {},
    });
    expect(meter.measurements).toEqual([
      expect.objectContaining({
        direction: "egress",
        channel: "client-live-websocket",
        notifyChange: false,
      }),
    ]);
    hub.publish({
      ownerId: "owner-1",
      scope: { kind: "current-user" },
      resource: "settings",
      action: "updated",
      entityId: null,
      revision: 1,
      payload: {},
    });
    expect(meter.measurements).toHaveLength(2);
    expect(meter.measurements.at(-1)).toMatchObject({
      ownerId: "owner-1",
      direction: "egress",
      channel: "client-live-websocket",
      notifyChange: true,
    });
    hub.close();
  });

  it("meters worker control text but leaves binary relay classification to its boundary", async () => {
    const meter = new RecordingMeter();
    const bridge = new MeteredWorkerCommandBus(new WorkerBridge(), meter);
    const socket = new TestWorkerSocket();
    bridge.attach("worker-1", socket, "owner-1");
    const response = bridge.request("worker-1", { type: "code.probe" });
    const request = JSON.parse(String(socket.sent.at(-1))) as {
      requestId: string;
    };
    const responseFrame = JSON.stringify(
      workerResponseEnvelopeSchema.parse({
        kind: "response",
        requestId: request.requestId,
        ok: true,
        result: { available: true },
      }),
    );
    socket.emit("message", responseFrame, false);
    await expect(response).resolves.toEqual({ available: true });
    socket.emit("message", new Uint8Array([1, 2, 3]), true);

    expect(meter.measurements).toEqual([
      expect.objectContaining({
        direction: "egress",
        channel: "worker-control-websocket",
      }),
      expect.objectContaining({
        direction: "ingress",
        channel: "worker-control-websocket",
        bytes: Buffer.byteLength(responseFrame),
      }),
    ]);
    bridge.close();
  });
});
