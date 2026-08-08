export class RemoteSurfaceRfbChannel {
  binaryType: BinaryType = "arraybuffer";
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readonly protocol = "binary";
  #readyState: number | string = 1;

  constructor(private readonly sendBytes: (bytes: Uint8Array) => boolean) {}

  get readyState(): number | string {
    return this.#readyState;
  }

  send(data: ArrayBuffer | ArrayBufferView): void {
    if (this.#readyState !== 1 && this.#readyState !== "open") {
      throw new Error("Remote Desktop channel is not open.");
    }
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (!this.sendBytes(bytes)) {
      this.fail("Remote Desktop transport is unavailable.");
    }
  }

  receive(bytes: Uint8Array): void {
    if (this.#readyState !== 1 && this.#readyState !== "open") return;
    const copy = Uint8Array.from(bytes);
    this.onmessage?.(
      new MessageEvent("message", {
        data: copy.buffer,
      }),
    );
  }

  close(): void {
    if (this.#readyState === 3 || this.#readyState === "closed") return;
    this.#readyState = 3;
    this.onclose?.(
      new CloseEvent("close", {
        code: 1000,
        reason: "Remote Desktop disconnected",
        wasClean: true,
      }),
    );
  }

  fail(message: string): void {
    if (this.#readyState === 3 || this.#readyState === "closed") return;
    this.onerror?.(new ErrorEvent("error", { message }));
    this.#readyState = 3;
    this.onclose?.(
      new CloseEvent("close", {
        code: 1011,
        reason: message,
        wasClean: false,
      }),
    );
  }
}
