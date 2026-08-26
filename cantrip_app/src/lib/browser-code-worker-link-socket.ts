import {
  tunnelAttachmentInitializeSchema,
  type TunnelAttachmentReady,
  type WorkerLinkChannelCloseCode,
} from "@cantrip/protocol";

import {
  openTunnelWorkerLink,
  type TunnelWorkerLinkConnection,
} from "@/lib/tunnel-worker-link";

const CONNECTING = 0;
export const BROWSER_CODE_TUNNEL_SOCKET_OPEN = 1;
const CLOSING = 2;
export const BROWSER_CODE_TUNNEL_SOCKET_CLOSED = 3;

export interface BrowserCodeTunnelSocket extends EventTarget {
  binaryType: BinaryType;
  readonly bufferedAmount: number;
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  send(data: ArrayBuffer | string): void;
  setMessageConsumer?(
    consumer: (event: MessageEvent<unknown>) => Promise<void>,
  ): void;
}

export interface BrowserCodeWorkerLinkSocketInput {
  attachmentId: string;
  expiresAt: string;
  tunnelId: string;
  workerId: string;
}

export interface BrowserCodeWorkerLinkSocketDependencies {
  openLink: typeof openTunnelWorkerLink;
  queue(callback: () => void): void;
}

const defaultDependencies: BrowserCodeWorkerLinkSocketDependencies = {
  openLink: openTunnelWorkerLink,
  queue: queueMicrotask,
};

export function createBrowserCodeWorkerLinkSocket(
  input: BrowserCodeWorkerLinkSocketInput,
  dependencies: BrowserCodeWorkerLinkSocketDependencies = defaultDependencies,
): BrowserCodeTunnelSocket {
  return new BrowserCodeWorkerLinkSocket(input, dependencies);
}

class BrowserCodeWorkerLinkSocket
  extends EventTarget
  implements BrowserCodeTunnelSocket
{
  binaryType: BinaryType = "arraybuffer";
  #connection: TunnelWorkerLinkConnection | null = null;
  #initialized = false;
  #messageConsumer: ((event: MessageEvent<unknown>) => Promise<void>) | null =
    null;
  #readyState = CONNECTING;

  constructor(
    private readonly input: BrowserCodeWorkerLinkSocketInput,
    private readonly dependencies: BrowserCodeWorkerLinkSocketDependencies,
  ) {
    super();
    void this.#open();
  }

  get bufferedAmount(): number {
    return this.#connection?.bufferedAmount ?? 0;
  }

  get readyState(): number {
    return this.#readyState;
  }

  setMessageConsumer(
    consumer: (event: MessageEvent<unknown>) => Promise<void>,
  ): void {
    if (this.#messageConsumer) {
      throw new Error("The protected Code transport already has a consumer.");
    }
    this.#messageConsumer = consumer;
  }

  close(code = 1000, reason = ""): void {
    if (
      this.#readyState === CLOSING ||
      this.#readyState === BROWSER_CODE_TUNNEL_SOCKET_CLOSED
    )
      return;
    this.#readyState = CLOSING;
    const connection = this.#connection;
    this.#connection = null;
    connection?.close(closeCodeFromWebSocket(code));
    this.#finishClose(code, reason, code === 1000);
  }

  send(data: ArrayBuffer | string): void {
    if (
      this.#readyState !== BROWSER_CODE_TUNNEL_SOCKET_OPEN ||
      !this.#connection
    ) {
      throw new DOMException(
        "The protected Code transport is not open.",
        "InvalidStateError",
      );
    }
    if (typeof data === "string") {
      if (this.#initialized) {
        this.#fail("The protected Code transport initialized twice.");
        return;
      }
      let initialize: unknown;
      try {
        initialize = JSON.parse(data);
      } catch {
        initialize = null;
      }
      if (!tunnelAttachmentInitializeSchema.safeParse(initialize).success) {
        this.#fail("The protected Code transport initialization was invalid.");
        return;
      }
      this.#initialized = true;
      const route = this.#connection.tunnelRoute;
      const ready = {
        type: "ready",
        attachmentId: route.attachmentId,
        destinationEndpointId: route.destinationEndpointId,
        expiresAt: this.input.expiresAt,
        sourceEndpointId: route.sourceEndpointId,
        tunnelId: route.tunnelId,
      } satisfies TunnelAttachmentReady;
      void this.#deliver(JSON.stringify(ready)).then(
        () => {
          this.dependencies.queue(() => this.#connection?.activate());
        },
        () => this.#fail("The protected Code transport rejected readiness."),
      );
      return;
    }
    if (!this.#initialized || !this.#connection.send(new Uint8Array(data))) {
      this.#fail("The protected Code transport send queue is congested.");
    }
  }

  async #open(): Promise<void> {
    try {
      const connection = await this.dependencies.openLink({
        attachmentId: this.input.attachmentId,
        onClose: (code) => this.#workerLinkClosed(code),
        onFrame: (frame) => this.#deliver(frame.slice().buffer),
        workerId: this.input.workerId,
      });
      if (this.#readyState !== CONNECTING) {
        connection.close("normal");
        return;
      }
      this.#connection = connection;
      this.#readyState = BROWSER_CODE_TUNNEL_SOCKET_OPEN;
      this.dispatchEvent(new Event("open"));
    } catch {
      if (this.#readyState !== CONNECTING) return;
      this.dispatchEvent(new Event("error"));
      this.#finishClose(1013, "Protected Code transport unavailable", false);
    }
  }

  async #deliver(data: string | ArrayBuffer): Promise<void> {
    if (this.#readyState !== BROWSER_CODE_TUNNEL_SOCKET_OPEN) return;
    const event = new MessageEvent<unknown>("message", { data });
    if (this.#messageConsumer) {
      await this.#messageConsumer(event);
      return;
    }
    this.dispatchEvent(event);
  }

  #workerLinkClosed(code: WorkerLinkChannelCloseCode): void {
    if (
      this.#readyState === CLOSING ||
      this.#readyState === BROWSER_CODE_TUNNEL_SOCKET_CLOSED
    )
      return;
    this.#connection = null;
    const authorizationEnded =
      code === "revoked" || code === "lifetime-expired";
    this.#finishClose(
      authorizationEnded ? 1008 : 1012,
      `WorkerLink channel closed: ${code}`,
      false,
    );
  }

  #fail(message: string): void {
    if (
      this.#readyState === CLOSING ||
      this.#readyState === BROWSER_CODE_TUNNEL_SOCKET_CLOSED
    )
      return;
    this.#readyState = CLOSING;
    this.dispatchEvent(new Event("error"));
    const connection = this.#connection;
    this.#connection = null;
    connection?.close("congested");
    this.#finishClose(1013, message, false);
  }

  #finishClose(code: number, reason: string, wasClean: boolean): void {
    if (this.#readyState === BROWSER_CODE_TUNNEL_SOCKET_CLOSED) return;
    this.#readyState = BROWSER_CODE_TUNNEL_SOCKET_CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean }));
  }
}

function closeCodeFromWebSocket(code: number): WorkerLinkChannelCloseCode {
  if (code === 1000) return "normal";
  if (code === 1008) return "revoked";
  if (code === 1013) return "congested";
  return "endpoint-disconnected";
}
