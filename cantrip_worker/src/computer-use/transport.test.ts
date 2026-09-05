import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CuaNativeError, CuaProcessError } from "./errors.js";
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
  function host(id, callId=1) { send({kind:'hostCall',evaluationRequestId:id,callId,action:{operation:'snapshot',callId}}); }
  process.stdin.on('data', bytes => {
    buffer = Buffer.concat([buffer, bytes]);
    while(buffer.length >= 8) {
      const length = 8 + buffer.readUInt32BE(0) + buffer.readUInt32BE(4);
      if(buffer.length < length) break;
      const message = JSON.parse(buffer.toString('utf8',8,8+buffer.readUInt32BE(0))).message;
      buffer = buffer.subarray(length);
      if(message.kind === 'cancel') {
        if(waiting.get(message.requestId)?.late) host(message.requestId,2);
        if(waiting.get(message.requestId) !== 'ignore') { waiting.delete(message.requestId); error(message.requestId,'cancelled'); }
        continue;
      }
      if(message.kind === 'hostResult') {
        const active = waiting.get(message.evaluationRequestId);
        if(!active) { event({kind:'unexpected-host-result'}); continue; }
        if(message.callId < active.calls) host(message.evaluationRequestId,message.callId+1);
        else { waiting.delete(message.evaluationRequestId); ok(message.evaluationRequestId,{hostResult:message.result,callId:message.callId}); }
        continue;
      }
      const id = message.requestId, kind = message.operation.operation;
      if(kind === 'host') { waiting.set(id,{calls:message.operation.calls ?? 1,late:message.operation.late}); host(id); }
      else if(kind === 'host-duplicate') { host(id); host(id); }
      else if(kind === 'host-overlap') { host(id); host(id,2); }
      else if(kind === 'host-gap') { host(id,2); }
      else if(kind === 'host-unknown') { host(id+1); }
      else if(kind === 'host-result-inbound') { send({kind:'hostResult',evaluationRequestId:id,callId:1,result:{status:'ok',data:null}}); }
      else if(kind === 'finish-host') { waiting.delete(message.operation.evaluationRequestId); if(message.operation.error) error(message.operation.evaluationRequestId,'invalid-request'); else ok(message.operation.evaluationRequestId,{finished:true}); ok(id,{}); }
      else if(kind === 'wait' || kind === 'ignore') { waiting.set(id,kind); event({kind:'waiting',requestId:id}); }
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("CUA child transport", () => {
  it("awaits a host callback without blocking native requests on the same process", async () => {
    const transport = fixture();
    const signals: AbortSignal[] = [];
    const onHostCall = vi.fn(async (action, signal: AbortSignal) => {
      signals.push(signal);
      expect(action).toEqual({ operation: "snapshot", callId: signals.length });
      expect(signal.aborted).toBe(false);
      return (await transport.request({ operation: "echo" })).data;
    });
    await expect(
      transport.request({ operation: "host", calls: 3 }, { onHostCall }),
    ).resolves.toEqual({
      data: { hostResult: { status: "ok", data: { id: 4 } }, callId: 3 },
      payload: Buffer.alloc(0),
    });
    expect(onHostCall).toHaveBeenCalledTimes(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await expect(
      transport.request({ operation: "echo" }),
    ).resolves.toMatchObject({ data: { id: 5 } });
  });

  it("allows all 64 sequential host calls without consuming request IDs or slots", async () => {
    const transport = fixture();
    const onHostCall = vi.fn(async () => null);
    const controllers = Array.from({ length: 15 }, () => new AbortController());
    const waiting = controllers.map((controller) =>
      transport
        .request({ operation: "wait" }, { signal: controller.signal })
        .catch((error) => error),
    );
    await expect(
      transport.request({ operation: "host", calls: 64 }, { onHostCall }),
    ).resolves.toMatchObject({ data: { callId: 64 } });
    expect(onHostCall).toHaveBeenCalledTimes(64);
    controllers.forEach((controller) => controller.abort());
    await Promise.all(waiting);
    await expect(
      transport.request({ operation: "echo" }),
    ).resolves.toMatchObject({ data: { id: 17 } });
  });

  it.each([
    "host-duplicate",
    "host-overlap",
    "host-gap",
    "host-unknown",
    "host-result-inbound",
    "host-budget",
  ])(
    "rejects invalid host rendezvous %s without unbounded callback work",
    async (operation) => {
      const transport = fixture();
      const onHostCall = vi.fn(async () =>
        operation === "host-overlap" ? new Promise<null>(() => {}) : null,
      );
      await expect(
        transport.request(
          {
            operation: operation === "host-budget" ? "host" : operation,
            calls: 65,
          },
          { onHostCall },
        ),
      ).rejects.toMatchObject({ code: "protocol-error" });
      expect(onHostCall.mock.calls.length).toBeLessThanOrEqual(
        operation === "host-budget" ? 64 : 1,
      );
      expect(transport.closed).toBe(true);
    },
  );

  it("rejects host calls for requests without a trusted callback", async () => {
    const transport = fixture();
    await expect(
      transport.request({ operation: "host" }),
    ).rejects.toMatchObject({ code: "protocol-error" });
  });

  it.each([
    [new CuaNativeError("permission-denied"), "permission-denied"],
    [new CuaProcessError("capacity"), "capacity"],
    [new CuaProcessError("timeout"), "cancelled"],
    [new Error("private target password"), "invalid-request"],
    [
      { code: "permission-denied", message: "private spoofed error" },
      "invalid-request",
    ],
  ] as const)("returns safe host failure %s as %s", async (error, code) => {
    const transport = fixture();
    const result = await transport.request(
      { operation: "host" },
      {
        onHostCall: async () => {
          throw error;
        },
      },
    );
    expect(result.data).toMatchObject({
      hostResult: {
        status: "error",
        error: { code, message: new CuaNativeError(code).message },
      },
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(transport.closed).toBe(false);
  });

  it("normalizes undefined callback results and safely rejects unencodable results", async () => {
    const transport = fixture();
    const result = await transport.request(
      { operation: "host" },
      { onHostCall: async () => undefined },
    );
    expect(result.data).toMatchObject({
      hostResult: { status: "ok", data: null },
    });
    const circular: { self?: unknown } = {};
    circular.self = circular;
    for (const value of [circular, "a".repeat(65_536), () => {}]) {
      const rejected = await transport.request(
        { operation: "host" },
        { onHostCall: async () => value },
      );
      expect(rejected.data).toMatchObject({
        hostResult: { status: "error", error: { code: "invalid-request" } },
      });
    }
    expect(transport.closed).toBe(false);
  });

  it("aborts host work, ignores cancellation-raced calls, and discards a late callback reply", async () => {
    const abort = new AbortController();
    const entered = deferred<AbortSignal>();
    const release = deferred<unknown>();
    const onEvent = vi.fn();
    const onFailure = vi.fn();
    const transport = fixture({ onEvent, onFailure });
    const onHostCall = vi.fn(async (_action, signal: AbortSignal) => {
      entered.resolve(signal);
      return release.promise;
    });
    const evaluating = transport.request(
      { operation: "host", late: true },
      { signal: abort.signal, onHostCall },
    );
    const rejected = expect(evaluating).rejects.toMatchObject({
      code: "cancelled",
      outcome: "unknown",
    });
    const hostSignal = await entered.promise;
    abort.abort();
    await rejected;
    expect(hostSignal.aborted).toBe(true);
    await transport.request({ operation: "echo" });
    release.resolve({ private: "late" });
    await transport.request({ operation: "echo" });
    expect(onHostCall).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it.each(["settle", "close", "crash", "timeout"] as const)(
    "aborts host callbacks on %s",
    async (kind) => {
      const entered = deferred<AbortSignal>();
      const release = deferred<unknown>();
      const transport = fixture();
      await transport.request({ operation: "echo" });
      const evaluating = transport.request(
        { operation: "host" },
        {
          timeoutMs: kind === "timeout" ? 30 : 1000,
          onHostCall: async (_action, signal) => {
            entered.resolve(signal);
            return release.promise;
          },
        },
      );
      const outcome = evaluating.catch((error) => error);
      const signal = await entered.promise;
      if (kind === "settle")
        await transport.request({
          operation: "finish-host",
          evaluationRequestId: 2,
          error: true,
        });
      if (kind === "close") await transport.close();
      if (kind === "crash")
        await transport.request({ operation: "crash" }).catch(() => {});
      const result = await outcome;
      expect(signal.aborted).toBe(true);
      if (kind === "settle") {
        expect(result).toBeInstanceOf(CuaNativeError);
        expect(transport.closed).toBe(false);
      } else expect(result).toMatchObject({ outcome: "unknown" });
      release.resolve(null);
    },
  );

  it("rejects premature evaluation success while its host action is still pending", async () => {
    const entered = deferred<AbortSignal>();
    const release = deferred<unknown>();
    const transport = fixture();
    const evaluation = transport
      .request(
        { operation: "host" },
        {
          onHostCall: async (_action, signal) => {
            entered.resolve(signal);
            return release.promise;
          },
        },
      )
      .catch((error) => error);
    const signal = await entered.promise;
    const finish = transport
      .request({ operation: "finish-host", evaluationRequestId: 1 })
      .catch((error) => error);
    expect(await evaluation).toMatchObject({
      code: "protocol-error",
      outcome: "unknown",
    });
    expect(await finish).toMatchObject({
      code: "protocol-error",
      outcome: "unknown",
    });
    expect(signal.aborted).toBe(true);
    release.resolve(null);
  });

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
    const waiting = Array.from({ length: 16 }, () =>
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

  it("reserves 16 native-close and four JS-reset slots while cancelled correlations are outstanding", async () => {
    const transport = fixture();
    await transport.request({ operation: "echo" });
    const abort = new AbortController();
    const waiting = Array.from({ length: 16 }, () =>
      transport
        .request({ operation: "ignore" }, { signal: abort.signal })
        .catch((error) => error),
    );
    abort.abort();
    for (const error of await Promise.all(waiting)) {
      expect(error).toMatchObject({ code: "cancelled", outcome: "unknown" });
    }
    await expect(
      transport.request({ operation: "echo" }),
    ).rejects.toMatchObject({ code: "capacity", outcome: "not-sent" });
    const cleanup = Array.from({ length: 20 }, () =>
      transport
        .request({ operation: "ignore" }, { lifecycle: true })
        .catch((error) => error),
    );
    await expect(
      transport.request({ operation: "echo" }, { lifecycle: true }),
    ).rejects.toMatchObject({ code: "capacity", outcome: "not-sent" });
    await transport.close();
    for (const error of await Promise.all(cleanup)) {
      // All 20 reserved requests were accepted, not refused as capacity.
      expect(error).toMatchObject({ code: "closed", outcome: "unknown" });
    }
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
