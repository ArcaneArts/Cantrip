import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeHistoryDelivery } from "../src/native-history-delivery.js";
import {
  NativeHistoryOutbox,
  type NativeHistoryOutboxRecord,
} from "../src/native-history-outbox.js";

const roots: string[] = [];
const pumps: NativeHistoryDelivery[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const pump of pumps.splice(0)) pump.stop();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-history-delivery-"),
  );
  roots.push(directory);
  const input = {
    directory,
    workerId: "worker",
    chatId: "chat",
    bindingId: "binding",
    service: {
      ownerId: () => "owner",
      serverIdentity: () => "server",
      componentKey: (_scope: string, revision = 1) => ({
        key: new Uint8Array(32).fill(revision),
        keyRevision: revision,
      }),
    },
  };
  return { input, outbox: await NativeHistoryOutbox.open(input) };
}

const receipt = (record: NativeHistoryOutboxRecord) => ({
  committed: true as const,
  streamId: record.streamId,
  sequence: record.sequence,
  recordId: record.recordId,
  digest: record.digest,
  commitId: `00000000-0000-4000-8000-${String(record.sequence).padStart(12, "0")}`,
});
function pump(options: ConstructorParameters<typeof NativeHistoryDelivery>[0]) {
  const delivery = new NativeHistoryDelivery({
    retryDelayMs: 10,
    maxRetryDelayMs: 30,
    ...options,
  });
  pumps.push(delivery);
  return delivery;
}

describe("native history background delivery", () => {
  it("recovers a lost HTTP response with the same batch and no UI/new-event wakeup", async () => {
    const { outbox } = await fixture();
    const first = await outbox.append(
      randomUUID(),
      '{"opaque":"original wire bytes"}\n',
    );
    const second = await outbox.append(randomUUID(), '{"opaque":"successor"}');
    // This fixture is a transport receipt store, not proof of canonical DB
    // ingestion. It deliberately closes a socket after saving its first receipt.
    const committed = new Map<
      string,
      { body: string; receipt: ReturnType<typeof receipt> }
    >();
    const deliveries: string[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      deliveries.push(data.record.recordId);
      const existing = committed.get(data.record.recordId);
      if (existing) {
        if (existing.body !== data.body) {
          response.writeHead(409).end();
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(existing.receipt));
        return;
      }
      const result = receipt(data.record);
      committed.set(data.record.recordId, { body: data.body, receipt: result });
      if (data.record.recordId === first.recordId) {
        request.socket.destroy();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(result));
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture port");
    const errors = vi.fn();
    const delivery = pump({
      outbox,
      onError: errors,
      deliver: async (record, body, signal) => {
        const response = await fetch(`http://127.0.0.1:${address.port}`, {
          method: "POST",
          body: JSON.stringify({ record, body }),
          signal,
        });
        if (!response.ok) throw new Error("Fixture receipt rejected");
        return (await response.json()) as ReturnType<typeof receipt>;
      },
    });
    delivery.wake();
    await vi.waitFor(async () => expect(await outbox.pending()).toEqual([]));
    delivery.stop();
    expect(deliveries).toEqual([
      first.recordId,
      first.recordId,
      second.recordId,
    ]);
    expect(committed.size).toBe(2);
    expect(committed.get(first.recordId)?.body).toBe(
      await outbox.openBody(first),
    );
    expect(errors).toHaveBeenCalledWith(expect.any(Error), "deliver");
  });

  it("retries local ACK failure without replacing an already committed batch", async () => {
    const { outbox } = await fixture();
    const record = await outbox.append(randomUUID(), "prepared batch");
    const acknowledge = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk failure"))
      .mockImplementation((result) => outbox.acknowledgeCommitted(result));
    const deliver = vi.fn(async (next) => receipt(next));
    const delivery = pump({
      outbox: {
        pending: () => outbox.pending(),
        openBody: (next) => outbox.openBody(next),
        acknowledgeCommitted: acknowledge,
      },
      deliver,
    });
    delivery.wake();
    await vi.waitFor(async () => expect(await outbox.pending()).toEqual([]));
    delivery.stop();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls.map(([next]) => next)).toEqual([record, record]);
  });

  it("stop aborts only delivery and a replacement pump recovers pending work", async () => {
    const { input, outbox } = await fixture();
    const record = await outbox.append(randomUUID(), "prepared");
    const started = vi.fn();
    const first = pump({
      outbox,
      deliver: (_record, _body, signal) =>
        new Promise((_resolve, reject) => {
          started(signal);
          signal.addEventListener("abort", () => reject(new Error("stopped")), {
            once: true,
          });
        }),
    });
    first.wake();
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    first.stop();
    expect(started.mock.calls[0]![0].aborted).toBe(true);
    expect(await outbox.pending()).toEqual([record]);
    first.wake(); // disposed pumps cannot restart themselves
    const reopened = await NativeHistoryOutbox.open(input);
    const deliver = vi.fn(async (next) => receipt(next));
    const second = pump({ outbox: reopened, deliver });
    second.wake();
    await vi.waitFor(async () => expect(await reopened.pending()).toEqual([]));
    second.stop();
    expect(deliver).toHaveBeenCalledOnce();
    expect(started).toHaveBeenCalledOnce();
  });

  it("serializes wakes during a held request and delivers a newly appended successor", async () => {
    const { outbox } = await fixture();
    const first = await outbox.append(randomUUID(), "one");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deliver = vi.fn(async (next) => {
      if (next.sequence === 1) await held;
      return receipt(next);
    });
    const delivery = pump({ outbox, deliver });
    delivery.wake();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    const second = await outbox.append(randomUUID(), "two");
    for (let i = 0; i < 20; i++) delivery.wake();
    expect(deliver).toHaveBeenCalledOnce();
    release();
    await vi.waitFor(async () => expect(await outbox.pending()).toEqual([]));
    delivery.stop();
    expect(deliver.mock.calls.map(([next]) => next.recordId)).toEqual([
      first.recordId,
      second.recordId,
    ]);
  });

  it("a failing error sink cannot prevent autonomous retry", async () => {
    const { outbox } = await fixture();
    await outbox.append(randomUUID(), "one");
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async (next) => receipt(next));
    const delivery = pump({
      outbox,
      deliver,
      onError: () => {
        throw new Error("logger unavailable");
      },
    });
    delivery.wake();
    await vi.waitFor(async () => expect(await outbox.pending()).toEqual([]));
    delivery.stop();
    expect(deliver).toHaveBeenCalledTimes(2);
  });
});
