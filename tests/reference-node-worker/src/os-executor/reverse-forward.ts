import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

const WINDOW = 65_536;
const MAX_BUFFER = 2 * 1024 * 1024;
const MAX_CLIENTS = 16;
interface Peer {
  id: number;
  socket: Socket;
  connected: boolean;
  credit: number;
  receiveCredit: number;
  pending: Buffer;
  readEof: boolean;
  finSent: boolean;
  writeEof: boolean;
}

/** One Server-admitted guest listener. Only its explicit Worker-host target is
 * dialed; guest frames cannot supply an address or install another listener. */
export class OsReverseForward {
  private incoming: Buffer = Buffer.alloc(0);
  private readonly peers = new Map<number, Peer>();
  private readonly pending: Buffer[] = [];
  private pendingBytes = 0;
  private blocked = false;
  private ended = false;
  private lastId = 0;
  private resolveClosed!: () => void;
  readonly closed = new Promise<void>((resolve) => {
    this.resolveClosed = resolve;
  });
  readonly stats = { opened: 0, closed: 0, fromGuest: 0, toGuest: 0 };
  error: Error | null = null;

  constructor(
    private readonly stream: Duplex,
    private readonly target: {
      host: "127.0.0.1" | "localhost" | "::1";
      port: number;
    },
  ) {
    if (
      !["127.0.0.1", "localhost", "::1"].includes(target.host) ||
      !Number.isInteger(target.port) ||
      target.port < 1 ||
      target.port > 65_535
    )
      throw new Error("Select a valid explicit Worker-host destination port.");
    stream.on("data", (chunk: Buffer) => {
      try {
        this.receive(chunk);
      } catch (error) {
        this.fail(error);
      }
    });
    stream.on("drain", () => this.drain());
    stream.on("error", (error) => this.fail(error));
    stream.once("end", () => this.close());
    stream.once("close", () => {
      this.close();
      this.resolveClosed();
    });
  }
  close() {
    if (this.ended) return;
    this.ended = true;
    for (const peer of this.peers.values()) peer.socket.destroy();
    this.stats.closed += this.peers.size;
    this.peers.clear();
    this.pending.length = 0;
    this.pendingBytes = 0;
    this.incoming = Buffer.alloc(0);
    this.stream.destroy();
  }
  private fail(error: unknown) {
    this.error ??=
      error instanceof Error
        ? error
        : new Error("Guest listener stream failed.");
    this.close();
  }
  private send(
    type: string,
    id: number,
    payload: Buffer = Buffer.alloc(0),
    fields: Record<string, number> = {},
  ) {
    if (this.ended) return;
    const header = Buffer.from(JSON.stringify({ type, id, ...fields }));
    const length = Buffer.alloc(8);
    length.writeUInt32BE(header.length);
    length.writeUInt32BE(payload.length, 4);
    const frame = Buffer.concat([length, header, payload]);
    if (this.blocked) {
      this.pending.push(frame);
      this.pendingBytes += frame.length;
      if (this.pendingBytes > MAX_BUFFER)
        this.fail(new Error("Guest listener output exceeded its bound."));
      return;
    }
    this.blocked = !this.stream.write(frame);
    if (this.blocked)
      for (const peer of this.peers.values()) peer.socket.pause();
  }
  private drain() {
    if (this.ended) return;
    this.blocked = false;
    while (this.pending.length && !this.blocked) {
      const frame = this.pending.shift()!;
      this.pendingBytes -= frame.length;
      this.blocked = !this.stream.write(frame);
    }
    if (!this.blocked) for (const peer of this.peers.values()) this.flush(peer);
  }
  private receive(bytes: Buffer) {
    if (this.ended) return;
    this.incoming = Buffer.concat([this.incoming, bytes]);
    if (this.incoming.length > MAX_BUFFER)
      throw new Error("Guest listener input exceeded its bound.");
    while (this.incoming.length >= 8) {
      const headerLength = this.incoming.readUInt32BE(0),
        payloadLength = this.incoming.readUInt32BE(4);
      if (!headerLength || headerLength > 1024 || payloadLength > WINDOW)
        throw new Error("Invalid guest listener frame size.");
      const size = 8 + headerLength + payloadLength;
      if (this.incoming.length < size) return;
      const header: unknown = JSON.parse(
        this.incoming.subarray(8, 8 + headerLength).toString(),
      );
      const payload = this.incoming.subarray(8 + headerLength, size);
      this.incoming = this.incoming.subarray(size);
      this.frame(header, payload);
    }
  }
  private integer(value: unknown, max = WINDOW): number {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > max
    )
      throw new Error("Invalid guest listener frame integer.");
    return value;
  }
  private frame(value: unknown, payload: Buffer) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid guest listener frame.");
    const header = value as Record<string, unknown>,
      id = this.integer(header.id, 2_147_483_647),
      type = header.type;
    const fields =
      type === "open"
        ? ["type", "id", "credit"]
        : type === "credit"
          ? ["type", "id", "bytes"]
          : ["type", "id"];
    if (
      !fields.every((key) => Object.hasOwn(header, key)) ||
      Object.keys(header).length !== fields.length ||
      typeof type !== "string" ||
      !["open", "credit", "data", "fin", "close"].includes(type) ||
      (type !== "data" && payload.length)
    )
      throw new Error("Invalid guest listener frame fields.");
    if (type === "open") {
      if (
        id <= this.lastId ||
        this.peers.size >= MAX_CLIENTS ||
        this.integer(header.credit) !== WINDOW
      )
        throw new Error("Guest listener connection escaped its limit.");
      this.lastId = id;
      this.open(id);
      return;
    }
    const peer = this.peers.get(id);
    if (!peer) return; // Late frames cannot affect a reused connection identity.
    if (type === "credit") {
      const amount = this.integer(header.bytes);
      if (peer.credit + amount > WINDOW)
        throw new Error("Guest listener credit escaped its window.");
      peer.credit += amount;
      this.flush(peer);
    } else if (type === "data") {
      if (
        !peer.connected ||
        peer.writeEof ||
        !payload.length ||
        payload.length > peer.receiveCredit
      )
        throw new Error("Guest listener data escaped its window.");
      peer.receiveCredit -= payload.length;
      this.stats.fromGuest += payload.length;
      peer.socket.write(payload, (error) => {
        if (error || this.ended || this.peers.get(id) !== peer) return;
        peer.receiveCredit += payload.length;
        this.send("credit", id, undefined, { bytes: payload.length });
      });
    } else if (type === "fin") {
      if (!peer.connected || peer.writeEof)
        throw new Error("Invalid guest listener half-close.");
      peer.writeEof = true;
      peer.socket.end();
    } else this.drop(peer, false);
  }
  private open(id: number) {
    const socket = connect({
      ...this.target,
      allowHalfOpen: true,
    });
    socket.pause();
    const peer: Peer = {
      id,
      socket,
      connected: false,
      credit: WINDOW,
      receiveCredit: WINDOW,
      pending: Buffer.alloc(0),
      readEof: false,
      finSent: false,
      writeEof: false,
    };
    this.peers.set(id, peer);
    this.stats.opened++;
    socket.once("connect", () => {
      if (this.ended || this.peers.get(id) !== peer) return;
      peer.connected = true;
      this.send("accepted", id, undefined, { credit: WINDOW });
      this.flush(peer);
    });
    socket.on("data", (bytes: Buffer) => {
      socket.pause();
      if (peer.pending.length || bytes.length > WINDOW) {
        this.fail(
          new Error("Host response escaped the guest listener buffer."),
        );
        return;
      }
      peer.pending = bytes;
      this.flush(peer);
    });
    socket.once("end", () => {
      peer.readEof = true;
      this.flush(peer);
    });
    socket.on("error", () => this.drop(peer));
    socket.once("close", () => {
      // A graceful Host close can precede delivery of its buffered reply into
      // the guest. Its close frame must not discard those queued bytes.
      if (!peer.readEof) this.drop(peer);
      else this.flush(peer);
    });
  }
  private flush(peer: Peer) {
    if (this.ended || !peer.connected || this.peers.get(peer.id) !== peer)
      return;
    while (peer.pending.length && peer.credit && !this.blocked) {
      const count = Math.min(peer.pending.length, peer.credit, WINDOW);
      const bytes = peer.pending.subarray(0, count);
      peer.pending = peer.pending.subarray(count);
      peer.credit -= count;
      this.stats.toGuest += count;
      this.send("data", peer.id, bytes);
    }
    if (!peer.pending.length && !this.blocked) {
      if (peer.readEof) {
        if (!peer.finSent) {
          peer.finSent = true;
          this.send("fin", peer.id);
        }
      } else if (peer.credit) peer.socket.resume();
    }
  }
  private drop(peer: Peer, notify = true) {
    if (this.peers.get(peer.id) !== peer) return;
    this.peers.delete(peer.id);
    this.stats.closed++;
    peer.socket.destroy();
    if (notify) this.send("close", peer.id);
  }
}
