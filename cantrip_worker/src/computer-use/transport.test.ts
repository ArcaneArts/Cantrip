import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CuaNativeError } from "./errors.js";
import {
  launchCuaTransport,
  type CuaTransport,
  type CuaTransportOptions,
} from "./transport.js";

const transports: CuaTransport[] = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
});

const fixtureSource = `
  let buffer = Buffer.alloc(0), sequence = 0;
  const waiting = new Map();
  function send(message, payload = Buffer.alloc(0)) {
    const json = Buffer.from(JSON.stringify({ version: 1, message }));
    const prefix = Buffer.alloc(8); prefix.writeUInt32BE(json.length, 0); prefix.writeUInt32BE(payload.length, 4);
    process.stdout.write(Buffer.concat([prefix, json, payload]));
  }
  function ok(id, data, payload) { send({kind:'response',requestId:id,result:{status:'ok',data}}, payload); }
  function error(id, code) { send({kind:'response',requestId:id,result:{status:'error',error:{code,message:'private target/password details'}}}); }
  function event(data) { send({kind:'event',sequence:++sequence,sessionId:'fixture-session',event:data}); }
  process.stdin.on('data', bytes => {
    buffer = Buffer.concat([buffer, bytes]);
    while(buffer.length >= 8) {
      const length = 8 + buffer.readUInt32BE(0) + buffer.readUInt32BE(4);
      if(buffer.length < length) break;
      const message = JSON.parse(buffer.toString('utf8',8,8+buffer.readUInt32BE(0))).message;
      buffer = buffer.subarray(length);
      if(message.kind === 'cancel') {
        if(waiting.get(message.requestId) !== 'ignore') { waiting.delete(message.requestId); error(message.requestId,'cancelled'); }
        continue;
      }
      const id = message.requestId, kind = message.operation.operation;
      if(kind === 'wait' || kind === 'ignore') { waiting.set(id,kind); event({kind:'waiting',requestId:id}); }
      else if(kind === 'crash') { process.stderr.write('private native stderr'); process.exit(23); }
      else if(kind === 'mismatch') { ok(id+1,{}); }
      else if(kind === 'permission') { error(id,'permission-denied'); }
      else if(kind === 'event') { event({kind:'cursorChanged'}); ok(id,{id}); }
      else if(kind === 'bad-event') { send({kind:'event',sequence:1,sessionId:null,event:{}}); send({kind:'event',sequence:1,sessionId:null,event:{}}); }
      else if(kind === 'binary') { ok(id,{id},Buffer.from([0,255,10,128])); }
      else if(kind === 'hang-close') { setInterval(()=>{},1000); ok(id,{}); }
      else { ok(id,{id}); }
    }
  });
`;

function fixture(options: CuaTransportOptions = {}): CuaTransport {
  const transport = launchCuaTransport(process.execPath, {
    ...options,
    args: ["-e", fixtureSource],
  });
  transports.push(transport);
  return transport;
}

describe("CUA child transport", () => {
  it("runs actual framed requests with monotonic IDs and binary payloads", async () => {
    const transport = fixture();
    expect(await transport.request({ operation: "echo" })).toEqual({
      data: { id: 1 },
      payload: Buffer.alloc(0),
    });
    expect(await transport.request({ operation: "binary" })).toEqual({
      data: { id: 2 },
      payload: Buffer.from([0, 255, 10, 128]),
    });
    await transport.close();
    expect(transport.closed).toBe(true);
    await expect(
      transport.request({ operation: "echo" }),
    ).rejects.toMatchObject({ code: "closed", outcome: "not-sent" });
  });

  it("settles signal cancellation as unknown and keeps unrelated work running", async () => {
    const abort = new AbortController();
    const onFailure = vi.fn();
    const transport = fixture({
      onFailure,
      onEvent() {
        abort.abort();
      },
    });
    const cancelled = transport.request(
      { operation: "wait" },
      { signal: abort.signal },
    );
    const unrelated = transport.request({ operation: "echo" });
    await expect(cancelled).rejects.toMatchObject({
      code: "cancelled",
      outcome: "unknown",
    });
    await expect(unrelated).resolves.toMatchObject({ data: { id: 2 } });
    await expect(
      transport.request({ operation: "echo" }),
    ).resolves.toMatchObject({ data: { id: 3 } });
    expect(onFailure).not.toHaveBeenCalled();
    expect(transport.closed).toBe(false);
  });

  it("does not send an already aborted request or consume its ID", async () => {
    const transport = fixture();
    await expect(
      transport.request({ operation: "echo" }, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "cancelled", outcome: "not-sent" });
    await expect(
      transport.request({ operation: "echo" }),
    ).resolves.toMatchObject({ data: { id: 1 } });
  });

  it("keeps a queued request outcome unknown if closed before the spawn event", async () => {
    const transport = fixture();
    const request = transport.request({ operation: "echo" });
    const rejected = expect(request).rejects.toMatchObject({
      code: "closed",
      outcome: "unknown",
    });
    await transport.close();
    await rejected;
  });

  it("operation deadlines cancel only that request and do not limit process lifetime", async () => {
    const onFailure = vi.fn();
    const transport = fixture({ onFailure });
    await transport.request({ operation: "echo" });
    await expect(
      transport.request({ operation: "wait" }, { timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: "timeout", outcome: "unknown" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await expect(
      transport.request({ operation: "echo" }),
    ).resolves.toMatchObject({ data: { id: 3 } });
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("terminates a process that never acknowledges cancellation after a bounded grace", async () => {
    let failed!: () => void;
    const failure = new Promise<void>((resolve) => {
      failed = resolve;
    });
    const onFailure = vi.fn(() => failed());
    const transport = fixture({ onFailure });
    await transport.request({ operation: "echo" });
    await expect(
      transport.request({ operation: "ignore" }, { timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: "timeout", outcome: "unknown" });
    await failure;
    expect(transport.closed).toBe(true);
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: "timeout", outcome: "unknown" }),
    );
  }, 5000);

  it("bounds accepted requests and cancelled correlations together", async () => {
    const transport = fixture();
    await transport.request({ operation: "echo" });
    const abort = new AbortController();
    const waiting = Array.from({ length: 32 }, () =>
      transport
        .request({ operation: "ignore" }, { signal: abort.signal })
        .catch((error) => error),
    );
    abort.abort();
    const errors = await Promise.all(waiting);
    expect(
      errors.every(
        (error) => error.code === "cancelled" && error.outcome === "unknown",
      ),
    ).toBe(true);
    await expect(
      transport.request({ operation: "echo" }),
    ).rejects.toMatchObject({ code: "capacity", outcome: "not-sent" });
    await transport.close();
  });

  it("reports crash outcomes as unknown without replay or exposing stderr", async () => {
    const onFailure = vi.fn();
    const transport = fixture({ onFailure });
    await transport.request({ operation: "echo" });
    const waiting = transport.request({ operation: "wait" });
    const crashed = transport.request({ operation: "crash" });
    const outcomes = await Promise.allSettled([waiting, crashed]);
    for (const result of outcomes) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({
          code: "process-exited",
          outcome: "unknown",
        });
        expect(result.reason.message).not.toContain("private");
      }
    }
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("distinguishes native operation rejection from process failure", async () => {
    const onFailure = vi.fn();
    const transport = fixture({ onFailure });
    await expect(
      transport.request({ operation: "permission" }),
    ).rejects.toBeInstanceOf(CuaNativeError);
    await expect(
      transport.request({ operation: "permission" }),
    ).rejects.toMatchObject({
      code: "permission-denied",
      message: "The operating system denied computer-use permission.",
    });
    await expect(
      transport.request({ operation: "echo" }),
    ).resolves.toBeDefined();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("does not let event or failure callbacks throw into frame processing", async () => {
    const transport = fixture({
      onEvent() {
        throw new Error("observer failure");
      },
      onFailure() {
        throw new Error("owner failure");
      },
    });
    await expect(
      transport.request({ operation: "event" }),
    ).resolves.toBeDefined();
    await expect(
      transport.request({ operation: "mismatch" }),
    ).rejects.toMatchObject({ code: "protocol-error", outcome: "unknown" });
  });

  it("rejects non-increasing event sequences", async () => {
    const transport = fixture();
    await expect(
      transport.request({ operation: "bad-event" }),
    ).rejects.toMatchObject({ code: "protocol-error" });
  });

  it("closes pending work as ambiguous and terminates a child that ignores EOF", async () => {
    const onFailure = vi.fn();
    const transport = fixture({ onFailure });
    await transport.request({ operation: "hang-close" });
    const waiting = transport.request({ operation: "wait" });
    const rejected = expect(waiting).rejects.toMatchObject({
      code: "closed",
      outcome: "unknown",
    });
    const start = performance.now();
    await transport.close();
    await rejected;
    expect(performance.now() - start).toBeLessThan(4000);
    expect(onFailure).not.toHaveBeenCalled();
  }, 5000);

  it("returns safe not-sent errors when the executable cannot launch", async () => {
    const transport = launchCuaTransport(
      path.join(process.cwd(), "missing-cua-executable"),
    );
    transports.push(transport);
    await expect(
      transport.request({ operation: "echo" }),
    ).rejects.toMatchObject({ code: "spawn-failed", outcome: "not-sent" });
  });
});
