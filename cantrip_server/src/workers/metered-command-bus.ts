import type {
  RemoteSurfaceFrameHeader,
  TunnelDataPlaneFrameHeader,
  WorkerCommand,
} from "@cantrip/protocol";

import type { AccountUsageRecorder } from "../account-usage/bandwidth-meter.js";
import type {
  WorkerCommandBus,
  WorkerNotificationListener,
  WorkerRequestOptions,
  WorkerSocket,
  WorkerSurfaceFrameListener,
  WorkerTunnelDataPlaneFrameListener,
  WorkerCommandBusStats,
} from "./bridge.js";

function frameByteLength(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + frameByteLength(chunk), 0);
  }
  return Buffer.byteLength(String(data));
}

function meteredWorkerSocket(
  socket: WorkerSocket,
  ownerId: string,
  recorder: AccountUsageRecorder,
): WorkerSocket {
  return {
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    get readyState() {
      return socket.readyState;
    },
    close(code, reason) {
      socket.close(code, reason);
    },
    on(event, listener) {
      if (event === "close") {
        socket.on("close", listener as () => void);
        return;
      }
      if (event === "error") {
        socket.on("error", listener as (error: Error) => void);
        return;
      }
      socket.on("message", (data, isBinary) => {
        if (!isBinary) {
          recorder.record({
            ownerId,
            direction: "ingress",
            channel: "worker-control-websocket",
            bytes: frameByteLength(data),
          });
        }
        (listener as (data: unknown, isBinary?: boolean) => void)(
          data,
          isBinary,
        );
      });
    },
    send(data, options) {
      socket.send(data, options);
      if (typeof data === "string") {
        recorder.record({
          ownerId,
          direction: "egress",
          channel: "worker-control-websocket",
          bytes: Buffer.byteLength(data),
        });
      }
    },
  };
}

/** Meters the physical worker control socket while preserving bus semantics. */
export class MeteredWorkerCommandBus implements WorkerCommandBus {
  constructor(
    readonly delegate: WorkerCommandBus,
    readonly recorder: AccountUsageRecorder,
  ) {}

  attach(
    workerId: string,
    socket: WorkerSocket,
    ownerId?: string,
    continuityIdentity?: Parameters<WorkerCommandBus["attach"]>[3],
  ) {
    return this.delegate.attach(
      workerId,
      ownerId ? meteredWorkerSocket(socket, ownerId, this.recorder) : socket,
      ownerId,
      continuityIdentity,
    );
  }

  close(): Promise<void> | void {
    return this.delegate.close();
  }

  disconnect(workerId: string, reason?: string, code?: number): void {
    if (code === undefined) this.delegate.disconnect?.(workerId, reason);
    else this.delegate.disconnect?.(workerId, reason, code);
  }

  isConnected(workerId: string): boolean {
    return this.delegate.isConnected(workerId);
  }

  stats(): WorkerCommandBusStats {
    return (
      this.delegate.stats?.() ?? {
        activeRequests: 0,
        connectedWorkers: 0,
        failedRequests: 0,
        routedRequests: 0,
        succeededRequests: 0,
      }
    );
  }

  sendSurfaceFrame(
    workerId: string,
    header: RemoteSurfaceFrameHeader,
    payload: Uint8Array,
  ): boolean {
    return this.delegate.sendSurfaceFrame(workerId, header, payload);
  }

  sendTunnelDataPlaneFrame(
    workerId: string,
    header: TunnelDataPlaneFrameHeader,
    payload: Uint8Array,
  ): boolean {
    return (
      this.delegate.sendTunnelDataPlaneFrame?.(workerId, header, payload) ??
      false
    );
  }

  subscribeWorkerDisconnect(workerId: string, listener: () => void) {
    return this.delegate.subscribeWorkerDisconnect(workerId, listener);
  }

  subscribeWorkerOffline(workerId: string, listener: () => void) {
    return (
      this.delegate.subscribeWorkerOffline?.(workerId, listener) ??
      this.delegate.subscribeWorkerDisconnect(workerId, listener)
    );
  }

  subscribeSurfaceFrames(
    workerId: string,
    listener: WorkerSurfaceFrameListener,
  ) {
    return this.delegate.subscribeSurfaceFrames(workerId, listener);
  }

  subscribeTunnelDataPlaneFrames(
    workerId: string,
    listener: WorkerTunnelDataPlaneFrameListener,
  ) {
    return (
      this.delegate.subscribeTunnelDataPlaneFrames?.(workerId, listener) ??
      (() => undefined)
    );
  }

  subscribeNotifications(
    workerId: string,
    listener: WorkerNotificationListener,
  ) {
    return (
      this.delegate.subscribeNotifications?.(workerId, listener) ??
      (() => undefined)
    );
  }

  request(
    workerId: string,
    command: WorkerCommand,
    options?: WorkerRequestOptions,
  ): Promise<unknown> {
    return this.delegate.request(workerId, command, options);
  }
}
