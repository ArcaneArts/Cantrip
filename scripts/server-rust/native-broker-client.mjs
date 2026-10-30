// A development carrier around the desktop's production native identity verifier.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
export function deadline(promise, label, ms = 15000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
export class NativeBrokerClient {
  constructor(binary, { kind = "connect", ticket, onFrame = () => {} }) {
    this.events = [];
    this.frames = [];
    this.sentFrames = [];
    this.errors = [];
    this.stderr = "";
    this.child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (bytes) => {
      this.stderr = (this.stderr + bytes).slice(-4096);
    });
    this.child.stdin.on("error", () => {});
    let initialized, failed;
    this.initialized = new Promise((resolve, reject) => {
      initialized = resolve;
      failed = reject;
    });
    this.exited = new Promise((resolve, reject) => {
      this.child.once("error", (error) => {
        failed(error);
        reject(error);
      });
      this.child.once("close", (code, signal) => {
        const value = { code, signal };
        this.exit = value;
        failed(
          new Error(
            "Native broker ended before initialization: " +
              JSON.stringify(value) +
              " " +
              this.stderr,
          ),
        );
        resolve(value);
      });
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const event = JSON.parse(line);
        if (event.event === "frame") {
          const bytes = Buffer.from(event.bytes, "base64url");
          this.frames.push(bytes);
          onFrame(bytes);
        } else {
          this.events.push(event);
          if (event.event === "closed") this.closed = event;
          if (["verified", "probe", "rejected"].includes(event.event))
            initialized(event);
        }
      } catch (error) {
        this.errors.push(error);
        failed(error);
      }
    });
    this.child.stdin.write(JSON.stringify({ kind, ticket }) + "\n");
  }
  async ready() {
    const value = await deadline(
      this.initialized,
      "Native broker verifier exceeded its production connection/proof deadlines",
    );
    if (this.errors.length) throw this.errors[0];
    return value;
  }
  send(bytes) {
    if (this.errors.length) throw this.errors[0];
    assert.equal(this.exit, undefined, "native broker remains alive");
    this.sentFrames.push(Buffer.from(bytes));
    this.child.stdin.write(
      JSON.stringify({
        op: "send",
        bytes: Buffer.from(bytes).toString("base64url"),
      }) + "\n",
    );
  }
  async close() {
    if (!this.exit) {
      this.child.stdin.end(JSON.stringify({ op: "close" }) + "\n");
    }
    let ended;
    try {
      ended = await deadline(
        this.exited,
        "Native broker did not complete close",
        10000,
      );
    } catch (error) {
      this.child.kill("SIGKILL");
      await this.exited;
      throw error;
    }
    assert.equal(ended.code, 0, this.stderr);
    if (this.errors.length) throw this.errors[0];
  }
}
