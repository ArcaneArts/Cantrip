import { RfbClient } from "./rfb-client.js";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

/** ZRLE wire probe: consumes real compressed frames, never substitutes raw pixels. */
export class RfbStreamProbe {
  readonly client: RfbClient;
  private running = true;
  private task?: Promise<void>;
  private failure?: unknown;
  private size?: Awaited<ReturnType<RfbClient["initialize"]>>;
  constructor(
    private stream: Duplex,
    private frame: (bytes: number) => void,
  ) {
    this.client = new RfbClient(stream);
  }
  async start() {
    this.size = await this.client.initialize();
    if (this.size.width !== 1440 || this.size.height !== 900)
      throw new Error("The measured VNC display has the wrong geometry.");
    const enc = Buffer.alloc(8);
    enc[0] = 2;
    enc.writeUInt16BE(1, 2);
    enc.writeInt32BE(16, 4);
    this.stream.write(enc);
    this.request(false);
    this.task = this.read();
    void this.task.catch((error) => {
      if (this.running) this.failure = error;
    });
    return this.size;
  }
  private request(incremental: boolean) {
    const b = Buffer.alloc(10);
    b[0] = 3;
    b[1] = Number(incremental);
    b.writeUInt16BE(this.size!.width, 6);
    b.writeUInt16BE(this.size!.height, 8);
    this.stream.write(b);
  }
  private async read() {
    while (this.running) {
      const type = (await this.client.read(1))[0];
      if (type === 0) {
        const head = await this.client.read(3),
          rects = head.readUInt16BE(1);
        let bytes = 4;
        if (rects > 4096)
          throw new Error("Measured VNC frame exceeded its rectangle bound.");
        for (let i = 0; i < rects; i++) {
          const r = await this.client.read(12),
            encoding = r.readInt32BE(8);
          bytes += 12;
          if (encoding !== 16)
            throw new Error(`Unexpected measured VNC encoding ${encoding}.`);
          const n = (await this.client.read(4)).readUInt32BE();
          if (n > 16 * 1024 * 1024)
            throw new Error(
              "Measured compressed VNC rectangle exceeded its bound.",
            );
          await this.client.read(n);
          bytes += 4 + n;
        }
        if (rects) this.frame(bytes);
        if (this.running) {
          await delay(1000 / 15);
          if (this.running) this.request(true);
        }
      } else if (type === 2) continue;
      else if (type === 3) {
        const h = await this.client.read(7),
          n = h.readUInt32BE(3);
        if (n > 8 * 1024 * 1024)
          throw new Error("Measured clipboard exceeded its bound.");
        await this.client.read(n);
      } else throw new Error(`Unexpected measured RFB message ${type}.`);
    }
  }
  key() {
    const p = Buffer.alloc(8);
    p[0] = 4;
    p[1] = 1;
    p.writeUInt32BE(0xff1b, 4);
    this.stream.write(p);
    const up = Buffer.from(p);
    up[1] = 0;
    this.stream.write(up);
  }
  clipboard(text: string) {
    const payload = Buffer.from(text, "latin1"),
      h = Buffer.alloc(8);
    h[0] = 6;
    h.writeUInt32BE(payload.length, 4);
    this.stream.write(Buffer.concat([h, payload]));
  }
  async close() {
    this.running = false;
    this.stream.destroy();
    await this.task?.catch(() => {});
    if (this.failure) throw this.failure;
  }
}
