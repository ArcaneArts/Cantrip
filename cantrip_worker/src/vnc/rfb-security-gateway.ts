import { createCipheriv } from "node:crypto";

class ByteQueue {
  #buffer = Buffer.alloc(0);

  get length(): number {
    return this.#buffer.length;
  }

  push(bytes: Uint8Array): void {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(bytes)]);
  }

  peek(length: number): Buffer | null {
    return this.#buffer.length >= length
      ? this.#buffer.subarray(0, length)
      : null;
  }

  read(length: number): Buffer | null {
    if (this.#buffer.length < length) return null;
    const value = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return value;
  }

  readAll(): Buffer {
    const value = this.#buffer;
    this.#buffer = Buffer.alloc(0);
    return value;
  }
}

type GatewayState =
  | "server-version"
  | "client-version"
  | "server-security"
  | "client-security"
  | "server-challenge"
  | "server-result"
  | "server-failure-length"
  | "server-failure-reason"
  | "raw"
  | "failed";

export interface RfbSecurityGatewayOptions {
  password: string | null;
  sendClient(bytes: Uint8Array): void;
  sendServer(bytes: Uint8Array): void;
  onError(message: string): void;
  onReady(): void;
}

function reverseBits(value: number): number {
  let reversed = 0;
  for (let index = 0; index < 8; index += 1) {
    reversed = (reversed << 1) | ((value >> index) & 1);
  }
  return reversed;
}

export function createVncChallengeResponse(
  password: string,
  challenge: Uint8Array,
): Buffer {
  if (challenge.byteLength !== 16) {
    throw new Error("A VNC authentication challenge must be 16 bytes.");
  }
  const passwordBytes = Buffer.from(password, "latin1").subarray(0, 8);
  const key = Buffer.alloc(8);
  for (let index = 0; index < passwordBytes.length; index += 1) {
    key[index] = reverseBits(passwordBytes[index]!);
  }
  const cipher = createCipheriv(
    "des-ede3-ecb",
    Buffer.concat([key, key, key]),
    null,
  );
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.from(challenge)), cipher.final()]);
}

export class RfbSecurityGateway {
  readonly #client = new ByteQueue();
  readonly #options: RfbSecurityGatewayOptions;
  readonly #server = new ByteQueue();
  #failureLength = 0;
  #selectedSecurityType: 1 | 2 | null = null;
  #state: GatewayState = "server-version";

  constructor(options: RfbSecurityGatewayOptions) {
    this.#options = options;
  }

  acceptClient(bytes: Uint8Array): void {
    if (this.#state === "failed") return;
    this.#client.push(bytes);
    this.process();
  }

  acceptServer(bytes: Uint8Array): void {
    if (this.#state === "failed") return;
    this.#server.push(bytes);
    this.process();
  }

  private process(): void {
    try {
      let progressed = true;
      while (progressed && this.#state !== "failed") {
        progressed = this.processOne();
      }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private processOne(): boolean {
    if (this.#state === "server-version") {
      const banner = this.#server.read(12);
      if (!banner) return false;
      if (banner.toString("ascii") !== "RFB 003.008\n") {
        throw new Error("Cantrip currently supports RFB 3.8 VNC endpoints.");
      }
      this.#options.sendClient(banner);
      this.#state = "client-version";
      return true;
    }
    if (this.#state === "client-version") {
      const banner = this.#client.read(12);
      if (!banner) return false;
      if (banner.toString("ascii") !== "RFB 003.008\n") {
        throw new Error("The VNC client did not negotiate RFB 3.8.");
      }
      this.#options.sendServer(banner);
      this.#state = "server-security";
      return true;
    }
    if (this.#state === "server-security") {
      const count = this.#server.peek(1)?.[0];
      if (count === undefined) return false;
      if (count === 0) {
        this.#server.read(1);
        this.#options.sendClient(Buffer.from([0]));
        this.#state = "server-failure-length";
        return true;
      }
      if (this.#server.length < count + 1) return false;
      this.#server.read(1);
      const types = this.#server.read(count);
      if (!types) return false;
      const offered = [...types];
      if (this.#options.password !== null && offered.includes(2)) {
        this.#selectedSecurityType = 2;
      } else if (offered.includes(1)) {
        this.#selectedSecurityType = 1;
      } else {
        this.rejectClient(
          this.#options.password === null
            ? "The VNC endpoint requires a password, but this tab has none configured."
            : "The VNC endpoint does not offer supported None or VNC authentication.",
        );
        return false;
      }
      this.#options.sendClient(Buffer.from([1, 1]));
      this.#state = "client-security";
      return true;
    }
    if (this.#state === "client-security") {
      const selection = this.#client.read(1);
      if (!selection) return false;
      if (selection[0] !== 1 || this.#selectedSecurityType === null) {
        throw new Error(
          "The VNC client rejected the worker authentication gateway.",
        );
      }
      this.#options.sendServer(Buffer.from([this.#selectedSecurityType]));
      this.#state =
        this.#selectedSecurityType === 2 ? "server-challenge" : "server-result";
      return true;
    }
    if (this.#state === "server-challenge") {
      const challenge = this.#server.read(16);
      if (!challenge) return false;
      if (this.#options.password === null) {
        throw new Error("VNC authentication requires a configured password.");
      }
      this.#options.sendServer(
        createVncChallengeResponse(this.#options.password, challenge),
      );
      this.#state = "server-result";
      return true;
    }
    if (this.#state === "server-result") {
      const result = this.#server.read(4);
      if (!result) return false;
      this.#options.sendClient(result);
      if (result.readUInt32BE(0) === 0) {
        this.#state = "raw";
        this.#options.onReady();
      } else {
        this.#state = "server-failure-length";
      }
      return true;
    }
    if (this.#state === "server-failure-length") {
      const length = this.#server.read(4);
      if (!length) return false;
      this.#failureLength = length.readUInt32BE(0);
      if (this.#failureLength > 64 * 1_024) {
        throw new Error("VNC endpoint returned an oversized failure reason.");
      }
      this.#options.sendClient(length);
      this.#state = "server-failure-reason";
      return true;
    }
    if (this.#state === "server-failure-reason") {
      const reason = this.#server.read(this.#failureLength);
      if (!reason) return false;
      this.#options.sendClient(reason);
      this.fail(`VNC authentication failed: ${reason.toString("utf8")}`);
      return false;
    }
    if (this.#state === "raw") {
      let progressed = false;
      if (this.#server.length > 0) {
        this.#options.sendClient(this.#server.readAll());
        progressed = true;
      }
      if (this.#client.length > 0) {
        this.#options.sendServer(this.#client.readAll());
        progressed = true;
      }
      return progressed;
    }
    return false;
  }

  private rejectClient(message: string): void {
    const reason = Buffer.from(message, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(reason.length);
    this.#options.sendClient(Buffer.concat([Buffer.from([0]), length, reason]));
    this.fail(message);
  }

  private fail(message: string): void {
    if (this.#state === "failed") return;
    this.#state = "failed";
    this.#options.onError(message);
  }
}
