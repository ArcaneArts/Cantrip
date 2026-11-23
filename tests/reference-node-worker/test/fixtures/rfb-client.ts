import type { Duplex } from "node:stream";

/** Small actual RFB 3.8 acceptance client; no screenshots or input are faked. */
export class RfbClient {
  private bytes = Buffer.alloc(0);
  private error: Error | null = null;
  private readonly waiters = new Set<() => void>();
  constructor(private readonly stream: Duplex) {
    stream.on("data", (bytes: Buffer) => {
      this.bytes = Buffer.concat([this.bytes, bytes]);
      if (this.bytes.length > 16 * 1024 * 1024)
        this.error = new Error(
          "RFB fixture exceeded its bounded receive buffer.",
        );
      this.wake();
    });
    stream.on("error", (error) => {
      this.error = error;
      this.wake();
    });
    stream.once("end", () => {
      this.error = new Error("RFB connection ended.");
      this.wake();
    });
    stream.once("close", () => {
      this.error = new Error("RFB connection closed.");
      this.wake();
    });
  }
  private wake() {
    for (const done of this.waiters) done();
    this.waiters.clear();
  }
  async read(size: number): Promise<Buffer> {
    while (this.bytes.length < size) {
      if (this.error) throw this.error;
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          this.waiters.delete(done);
          reject(new Error("RFB response timed out."));
        }, 30_000);
        this.waiters.add(done);
      });
    }
    const bytes = this.bytes.subarray(0, size);
    this.bytes = this.bytes.subarray(size);
    return bytes;
  }
  private send(bytes: Buffer) {
    this.stream.write(bytes);
  }
  async initialize() {
    if ((await this.read(12)).toString() !== "RFB 003.008\n")
      throw new Error("Expected RFB 3.8.");
    this.send(Buffer.from("RFB 003.008\n"));
    const count = (await this.read(1))[0]!;
    if (!(await this.read(count)).includes(1))
      throw new Error(
        "The protected VNC stream requires its expected None security mode.",
      );
    this.send(Buffer.from([1]));
    if ((await this.read(4)).readUInt32BE() !== 0)
      throw new Error("RFB security handshake failed.");
    this.send(Buffer.from([1])); // Shared client; do not evict other clients.
    const init = await this.read(24),
      nameSize = init.readUInt32BE(20);
    if (nameSize > 4096)
      throw new Error("RFB desktop name exceeds the fixture limit.");
    return {
      width: init.readUInt16BE(0),
      height: init.readUInt16BE(2),
      bitsPerPixel: init[4]!,
      name: (await this.read(nameSize)).toString(),
    };
  }
  async rawFrame(width: number, height: number, bitsPerPixel: number) {
    const encodings = Buffer.alloc(8);
    encodings[0] = 2;
    encodings.writeUInt16BE(1, 2);
    this.send(encodings);
    const request = Buffer.alloc(10);
    request[0] = 3;
    request.writeUInt16BE(width, 6);
    request.writeUInt16BE(height, 8);
    this.send(request);
    for (;;) {
      const type = (await this.read(1))[0];
      if (type === 2) continue; // Bell.
      if (type === 3) {
        const header = await this.read(7),
          size = header.readUInt32BE(3);
        if (size > 1024 * 1024)
          throw new Error("RFB clipboard exceeded its fixture bound.");
        await this.read(size);
        continue;
      }
      if (type !== 0) throw new Error(`Unexpected RFB server message ${type}.`);
      const header = await this.read(3),
        count = header.readUInt16BE(1);
      let pixels = 0;
      for (let i = 0; i < count; i++) {
        const rectangle = await this.read(12),
          w = rectangle.readUInt16BE(4),
          h = rectangle.readUInt16BE(6),
          encoding = rectangle.readInt32BE(8);
        if (encoding !== 0)
          throw new Error(`RFB did not honor Raw encoding: ${encoding}.`);
        const size = w * h * (bitsPerPixel / 8);
        if (!Number.isSafeInteger(size) || size > 16 * 1024 * 1024)
          throw new Error("RFB rectangle exceeds fixture bounds.");
        await this.read(size);
        pixels += w * h;
      }
      return pixels;
    }
  }
  key(keysym: number, down: boolean) {
    const message = Buffer.alloc(8);
    message[0] = 4;
    message[1] = Number(down);
    message.writeUInt32BE(keysym, 4);
    this.send(message);
  }
  pointer(x: number, y: number, mask: number) {
    const message = Buffer.alloc(6);
    message[0] = 5;
    message[1] = mask;
    message.writeUInt16BE(x, 2);
    message.writeUInt16BE(y, 4);
    this.send(message);
  }
}
