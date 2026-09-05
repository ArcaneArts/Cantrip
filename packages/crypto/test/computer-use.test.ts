import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import {
  CUA_CHUNK_BYTES,
  computerUseResultContentSchema,
  type ComputerUseChunkEvent,
  type ComputerUseResultContent,
} from "@cantrip/protocol/computer-use";
import type {
  EndpointContentContext,
  EndpointContentOpaque,
} from "@cantrip/protocol/endpoint-content";
import {
  openComputerUseRequest,
  openComputerUseResult,
  protectComputerUseRequest,
  protectComputerUseResult,
  type ComputerUseContentContext,
  type ComputerUseOpen,
  type ComputerUseSeal,
} from "../src/computer-use.js";
import {
  decryptEndpointContentPayload,
  encryptEndpointContentPayload,
} from "../src/endpoint-content.js";

const componentKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const context: ComputerUseContentContext = {
  serverId: "https://server.fixture",
  workerId: "worker-fixture",
  chatId: "chat-fixture",
  operationId: "9e3a7d34-7c68-493e-9d06-6a5cfe449cb4",
  operation: "observation.snapshot",
};
const otherOperationId = "a7c91b3f-7ef4-4ef1-aedf-8829f1af2467";
const digest = (value: Uint8Array) =>
  Array.from(sha256(value), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
const isZero = (value: Uint8Array) => value.every((byte) => byte === 0);

function crypto(ownerId = "fixture-owner", keyRevision = 7) {
  const seal: ComputerUseSeal = (context, plaintext) =>
    encryptEndpointContentPayload({
      ownerId,
      keyRevision,
      componentKey,
      context,
      plaintext,
    });
  const open: ComputerUseOpen = (context, opaque) =>
    decryptEndpointContentPayload({
      ownerId,
      keyRevision,
      componentKey,
      context,
      opaque,
    });
  return { seal, open };
}

function imageFixture(length?: number) {
  // A generated 1x1 PNG; longer fixtures append deterministic transport bytes.
  // No native screen capture, installation profile or credential is involved.
  const png = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6sE8AAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const payload = new Uint8Array(length ?? png.length).fill(0xa5);
  payload.set(png);
  const result = computerUseResultContentSchema.parse({
    status: "ok",
    operation: "observation.snapshot",
    chunkCount: Math.ceil(payload.length / CUA_CHUNK_BYTES),
    data: {
      session: {
        binding: {
          sessionId: "session-fixture",
          workerId: "worker-fixture",
          chatId: "chat-fixture",
          taskId: null,
          threadId: null,
          turnId: null,
        },
        target: {
          id: "window-fixture",
          generation: 1,
          kind: "window",
          title: "private-title-fixture",
          application: null,
          processId: null,
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          pixelWidth: 1,
          pixelHeight: 1,
          scaleFactor: 1,
          focused: false,
          minimized: false,
        },
        cursor: {
          appearance: {
            version: 1,
            style: "arrow",
            color: "#00FF00",
            size: 8,
            label: null,
            trail: false,
            visible: true,
          },
          position: { x: 0, y: 0 },
          trailPoints: [],
          updatedAtMs: 1,
          revision: 1,
        },
        observationRevision: 1,
      },
      image: {
        mediaType: "image/png",
        width: 1,
        height: 1,
        byteCount: payload.length,
        sha256: digest(payload),
        cursorIncluded: true,
      },
    },
  });
  return { result, payload };
}

async function protectedFixture(length?: number) {
  const fixture = imageFixture(length);
  const events: ComputerUseChunkEvent[] = [];
  const response = await protectComputerUseResult({
    context,
    ...fixture,
    seal: crypto().seal,
    emit: async (event) => {
      events.push(event);
    },
  });
  return { ...fixture, events, response };
}

const endpoint = (
  direction: "response" | "event",
  sequence = 0,
): EndpointContentContext => ({
  domain: "client-control-content",
  serverId: context.serverId,
  workerId: context.workerId,
  scopeId: context.chatId,
  operationId: context.operationId,
  operation: context.operation,
  direction,
  sequence,
});

describe("protected computer-use request", () => {
  const request = {
    operation: "cursor.move" as const,
    sessionId: "session-fixture",
    targetId: "window-fixture",
    targetGeneration: 1,
    position: { x: 30, y: 40 },
  };
  const requestContext = { ...context, operation: request.operation };

  it("round-trips using endpoint AEAD and clears temporary request bytes", async () => {
    const sealed: Uint8Array[] = [];
    const opened: Uint8Array[] = [];
    const opaque = await protectComputerUseRequest({
      context: requestContext,
      request,
      seal: async (context, bytes) => {
        sealed.push(bytes);
        return crypto().seal(context, bytes);
      },
    });
    expect(JSON.stringify(opaque)).not.toContain("window-fixture");
    expect(
      await openComputerUseRequest({
        context: requestContext,
        opaque,
        open: async (context, opaque) => {
          const bytes = await crypto().open(context, opaque);
          opened.push(bytes);
          return bytes;
        },
      }),
    ).toEqual(request);
    expect(sealed.every(isZero)).toBe(true);
    expect(opened.every(isZero)).toBe(true);
  });

  it("rejects outer and inner operation or correlation substitutions", async () => {
    const opaque = await protectComputerUseRequest({
      context: requestContext,
      request,
      seal: crypto().seal,
    });
    for (const changed of [
      { ...opaque, operationId: otherOperationId },
      { ...opaque, operation: "targets.list" },
    ])
      await expect(
        openComputerUseRequest({
          context: requestContext,
          opaque: changed,
          open: crypto().open,
        }),
      ).rejects.toThrow();
    await expect(
      protectComputerUseRequest({ context, request, seal: crypto().seal }),
    ).rejects.toThrow();
    const badInner = await crypto().seal(
      {
        ...endpoint("response"),
        operation: request.operation,
        direction: "request",
      },
      new TextEncoder().encode(JSON.stringify({ operation: "targets.list" })),
    );
    await expect(
      openComputerUseRequest({
        context: requestContext,
        opaque: { ...opaque, protectedContent: badInner },
        open: crypto().open,
      }),
    ).rejects.toThrow();
  });
});

describe("protected computer-use results", () => {
  it("binds requests, manifests, and every image chunk to the preview lifetime", async () => {
    const first = {
      ...context,
      previewLeaseId: "61dd30e8-fce4-4087-8e57-c998106ed0e1",
    };
    const second = {
      ...context,
      previewLeaseId: "16bff064-11cc-49ea-9636-bf5788924fc6",
    };
    const request = {
      operation: "observation.snapshot" as const,
      sessionId: "session-fixture",
      targetId: "window-fixture",
      targetGeneration: 1,
    };
    const protectedRequest = await protectComputerUseRequest({
      context: first,
      request,
      seal: crypto().seal,
    });
    expect(
      await openComputerUseRequest({
        context: first,
        opaque: protectedRequest,
        open: crypto().open,
      }),
    ).toEqual(request);
    for (const swapped of [second, context]) {
      await expect(
        openComputerUseRequest({
          context: swapped,
          opaque: {
            ...protectedRequest,
            previewLeaseId: swapped.previewLeaseId,
          },
          open: crypto().open,
        }),
      ).rejects.toThrow();
    }
    const fixture = imageFixture(CUA_CHUNK_BYTES + 1);
    async function protect(bound: ComputerUseContentContext) {
      const chunks: ComputerUseChunkEvent[] = [];
      const opaque = await protectComputerUseResult({
        context: bound,
        ...fixture,
        seal: crypto().seal,
        emit: async (chunk) => {
          chunks.push(chunk);
        },
      });
      return { opaque, chunks };
    }
    const old = await protect(first);
    const current = await protect(second);
    expect(
      (
        await openComputerUseResult({
          context: first,
          ...old,
          open: crypto().open,
        })
      ).payload,
    ).toEqual(fixture.payload);
    for (const swapped of [second, context]) {
      await expect(
        openComputerUseResult({
          context: swapped,
          ...old,
          open: crypto().open,
        }),
      ).rejects.toThrow();
    }
    for (let index = 0; index < current.chunks.length; index += 1) {
      const chunks = [...current.chunks];
      chunks[index] = old.chunks[index]!;
      await expect(
        openComputerUseResult({
          context: second,
          opaque: current.opaque,
          chunks,
          open: crypto().open,
        }),
      ).rejects.toThrow();
    }
  });

  it.each(["", "not-a-lease", "a".repeat(10_000)])(
    "rejects malformed preview lease metadata before sealing: %s",
    async (previewLeaseId) => {
      let seals = 0;
      await expect(
        protectComputerUseRequest({
          context: { ...context, operation: "targets.list", previewLeaseId },
          request: { operation: "targets.list" },
          seal: async (...args) => {
            seals += 1;
            return crypto().seal(...args);
          },
        }),
      ).rejects.toThrow();
      expect(seals).toBe(0);
    },
  );

  it("round-trips one real PNG and retains no temporary plaintext", async () => {
    const fixture = imageFixture();
    const original = fixture.payload.slice();
    const sealed: Uint8Array[] = [];
    const opened: Uint8Array[] = [];
    const events: ComputerUseChunkEvent[] = [];
    const response = await protectComputerUseResult({
      context,
      ...fixture,
      seal: async (context, bytes) => {
        sealed.push(bytes);
        return crypto().seal(context, bytes);
      },
      emit: async (event) => {
        events.push(event);
      },
    });
    const value = await openComputerUseResult({
      context,
      opaque: response,
      chunks: events,
      open: async (context, opaque) => {
        const bytes = await crypto().open(context, opaque);
        opened.push(bytes);
        return bytes;
      },
    });
    expect(value.result).toEqual(fixture.result);
    expect(value.payload).toEqual(original);
    expect(value.payload).not.toBe(fixture.payload);
    expect(fixture.payload).toEqual(original);
    expect(sealed.every(isZero)).toBe(true);
    expect(opened.every(isZero)).toBe(true);
    expect(JSON.stringify({ response, events })).not.toContain(
      "private-title-fixture",
    );
  });

  it("awaits each bounded chunk emission before emitting the next and returning the manifest", async () => {
    const fixture = imageFixture(CUA_CHUNK_BYTES * 2 + 71);
    const lengths: number[] = [];
    const emitted: number[] = [];
    let concurrent = 0;
    const events: ComputerUseChunkEvent[] = [];
    const response = await protectComputerUseResult({
      context,
      ...fixture,
      seal: async (context, bytes) => {
        if (context.direction === "event") lengths.push(bytes.length);
        return crypto().seal(context, bytes);
      },
      emit: async (event) => {
        concurrent += 1;
        expect(concurrent).toBe(1);
        await Promise.resolve();
        events.push(event);
        emitted.push(event.sequence);
        concurrent -= 1;
      },
    });
    expect(lengths).toEqual([CUA_CHUNK_BYTES, CUA_CHUNK_BYTES, 71]);
    expect(emitted).toEqual([0, 1, 2]);
    const order: string[] = [];
    const value = await openComputerUseResult({
      context,
      opaque: response,
      chunks: events,
      open: async (context, opaque) => {
        order.push(`${context.direction}:${context.sequence}`);
        return crypto().open(context, opaque);
      },
    });
    expect(order).toEqual(["response:0", "event:0", "event:1", "event:2"]);
    expect(value.payload).toEqual(fixture.payload);
  });

  it("supports metadata-only successes and protected errors without chunks", async () => {
    for (const result of [
      {
        status: "ok",
        operation: "targets.list",
        data: { targets: [] },
        chunkCount: 0,
      },
      {
        status: "error",
        operation: "targets.list",
        code: "permission-denied",
        message: "Permission was denied.",
        outcome: "rejected",
      },
    ] as ComputerUseResultContent[]) {
      const ctx = { ...context, operation: result.operation };
      const response = await protectComputerUseResult({
        context: ctx,
        result,
        seal: crypto().seal,
        emit: async () => {
          throw Error("unexpected chunk");
        },
      });
      expect(
        await openComputerUseResult({
          context: ctx,
          opaque: response,
          chunks: [],
          open: crypto().open,
        }),
      ).toEqual({ result, payload: null });
    }
  });

  it.each([
    "serverId",
    "workerId",
    "chatId",
    "operationId",
    "operation",
  ] as const)(
    "authenticates %s against actual endpoint associated data",
    async (field) => {
      const fixture = await protectedFixture();
      const changed = {
        ...context,
        [field]:
          field === "operationId"
            ? otherOperationId
            : field === "operation"
              ? "targets.list"
              : "other-fixture",
      };
      await expect(
        openComputerUseResult({
          context: changed,
          opaque: fixture.response,
          chunks: fixture.events,
          open: crypto().open,
        }),
      ).rejects.toThrow();
    },
  );

  it("authenticates the owner, direction, sequence and encryption revision", async () => {
    const fixture = await protectedFixture();
    const openers: ComputerUseOpen[] = [
      crypto("different-owner").open,
      crypto("fixture-owner", 8).open,
      (context, opaque) =>
        crypto().open({ ...context, direction: "request" }, opaque),
      (context, opaque) =>
        crypto().open({ ...context, sequence: context.sequence + 1 }, opaque),
      (context, opaque) =>
        crypto().open({ ...context, domain: "run-content" }, opaque),
    ];
    for (const open of openers)
      await expect(
        openComputerUseResult({
          context,
          opaque: fixture.response,
          chunks: fixture.events,
          open,
        }),
      ).rejects.toThrow();
  });

  it("authenticates the manifest before attempting any chunk decryption", async () => {
    const fixture = await protectedFixture();
    const damaged = structuredClone(fixture.response);
    const text = damaged.protectedContent.envelope.ciphertext;
    damaged.protectedContent.envelope.ciphertext =
      (text[0] === "A" ? "B" : "A") + text.slice(1);
    const directions: string[] = [];
    await expect(
      openComputerUseResult({
        context,
        opaque: damaged,
        chunks: fixture.events,
        open: async (context, opaque) => {
          directions.push(context.direction);
          return crypto().open(context, opaque);
        },
      }),
    ).rejects.toThrow();
    expect(directions).toEqual(["response"]);
  });

  it("rejects missing, duplicate, reordered, foreign and excess chunks", async () => {
    const fixture = await protectedFixture(CUA_CHUNK_BYTES * 2 + 71);
    const [a, b, c] = fixture.events as [
      ComputerUseChunkEvent,
      ComputerUseChunkEvent,
      ComputerUseChunkEvent,
    ];
    const invalid = [
      [a, b],
      [a, a, c],
      [b, a, c],
      [a, b, c, c],
      [a, { ...b, operationId: otherOperationId }, c],
      [a, { ...b, sequence: 3 }, c],
      [a, { ...b, protectedContent: a.protectedContent }, c],
    ];
    for (const chunks of invalid)
      await expect(
        openComputerUseResult({
          context,
          opaque: fixture.response,
          chunks,
          open: crypto().open,
        }),
      ).rejects.toThrow();
  });

  it("rejects authenticated short chunks and content inconsistent with the manifest digest", async () => {
    const fixture = await protectedFixture(CUA_CHUNK_BYTES + 71);
    const short = await crypto().seal(endpoint("event"), new Uint8Array(100));
    await expect(
      openComputerUseResult({
        context,
        opaque: fixture.response,
        chunks: [
          { ...fixture.events[0]!, protectedContent: short },
          fixture.events[1]!,
        ],
        open: crypto().open,
      }),
    ).rejects.toThrow();
    const changed = structuredClone(fixture.result);
    if (changed.status !== "ok" || !("image" in changed.data))
      throw Error("bad fixture");
    changed.data.image.sha256 = "00".repeat(32);
    const metadata = await crypto().seal(
      endpoint("response"),
      new TextEncoder().encode(JSON.stringify(changed)),
    );
    await expect(
      openComputerUseResult({
        context,
        opaque: { ...fixture.response, protectedContent: metadata },
        chunks: fixture.events,
        open: crypto().open,
      }),
    ).rejects.toThrow();
  });

  it("rejects mixed outer/inner revisions and chunks from another encryption revision", async () => {
    const fixture = await protectedFixture();
    const changed = structuredClone(fixture.events);
    changed[0]!.protectedContent.keyRevision += 1;
    await expect(
      openComputerUseResult({
        context,
        opaque: fixture.response,
        chunks: changed,
        open: crypto().open,
      }),
    ).rejects.toThrow();
    changed[0]!.protectedContent = await crypto("fixture-owner", 8).seal(
      endpoint("event"),
      fixture.payload,
    );
    await expect(
      openComputerUseResult({
        context,
        opaque: fixture.response,
        chunks: changed,
        open: crypto().open,
      }),
    ).rejects.toThrow();
  });

  it("clears all previously opened chunks when a later chunk fails authentication", async () => {
    const fixture = await protectedFixture(CUA_CHUNK_BYTES + 71);
    const changed = structuredClone(fixture.events);
    const text = changed[1]!.protectedContent.envelope.ciphertext;
    changed[1]!.protectedContent.envelope.ciphertext =
      (text[0] === "A" ? "B" : "A") + text.slice(1);
    const opened: Uint8Array[] = [];
    await expect(
      openComputerUseResult({
        context,
        opaque: fixture.response,
        chunks: changed,
        open: async (context, opaque) => {
          const bytes = await crypto().open(context, opaque);
          opened.push(bytes);
          return bytes;
        },
      }),
    ).rejects.toThrow();
    expect(opened).toHaveLength(2);
    expect(opened.every(isZero)).toBe(true);
  });

  it("rejects invalid manifest count/bytes and does not emit unauthenticated pixels", async () => {
    const fixture = imageFixture();
    let emitted = 0;
    const emit = async () => {
      emitted += 1;
    };
    await expect(
      protectComputerUseResult({
        context,
        ...fixture,
        payload: new Uint8Array([1]),
        seal: crypto().seal,
        emit,
      }),
    ).rejects.toThrow();
    await expect(
      protectComputerUseResult({
        context,
        ...fixture,
        result: {
          ...fixture.result,
          chunkCount: 2,
        } as ComputerUseResultContent,
        seal: crypto().seal,
        emit,
      }),
    ).rejects.toThrow();
    await expect(
      protectComputerUseResult({
        context,
        ...fixture,
        payload: new Uint8Array(16 * 1024 * 1024 + 1),
        seal: crypto().seal,
        emit,
      }),
    ).rejects.toThrow();
    expect(emitted).toBe(0);
  });

  it("clears plaintext when encryption/emission fails and preserves caller payload ownership", async () => {
    const fixture = imageFixture();
    const original = fixture.payload.slice();
    const buffers: Uint8Array[] = [];
    await expect(
      protectComputerUseResult({
        context,
        ...fixture,
        seal: async (context, bytes) => {
          buffers.push(bytes);
          return crypto().seal(context, bytes);
        },
        emit: async () => {
          throw Error("fixture delivery failed");
        },
      }),
    ).rejects.toThrow("fixture delivery failed");
    expect(buffers.every(isZero)).toBe(true);
    expect(fixture.payload).toEqual(original);
    let attempted: Uint8Array | undefined;
    await expect(
      protectComputerUseRequest({
        context: { ...context, operation: "targets.list" },
        request: { operation: "targets.list" },
        seal: async (_context, bytes) => {
          attempted = bytes;
          throw Error("fixture encryption failed");
        },
      }),
    ).rejects.toThrow();
    expect(attempted && isZero(attempted)).toBe(true);
  });

  it("rejects authenticated malformed metadata while clearing its plaintext", async () => {
    const plaintext = new TextEncoder().encode("{invalid-json");
    const protectedContent = await crypto().seal(
      endpoint("response"),
      plaintext,
    );
    let opened: Uint8Array | undefined;
    await expect(
      openComputerUseResult({
        context,
        opaque: { operationId: context.operationId, protectedContent },
        chunks: [],
        open: async (context, opaque) => {
          opened = await crypto().open(context, opaque);
          return opened;
        },
      }),
    ).rejects.toThrow();
    expect(opened && isZero(opened)).toBe(true);
  });

  it("pins operation context and borrowed pixels across asynchronous callbacks", async () => {
    const fixture = imageFixture(CUA_CHUNK_BYTES + 1);
    const expected = fixture.payload.slice();
    const sendingContext = { ...context };
    const events: ComputerUseChunkEvent[] = [];
    const response = await protectComputerUseResult({
      context: sendingContext,
      ...fixture,
      seal: crypto().seal,
      emit: async (event) => {
        events.push(event);
        sendingContext.operationId = otherOperationId;
        sendingContext.chatId = "next-chat";
        fixture.payload.fill(0);
      },
    });
    expect(response.operationId).toBe(context.operationId);
    const receivingContext = { ...context };
    const opened = await openComputerUseResult({
      context: receivingContext,
      opaque: response,
      chunks: events,
      open: async (endpoint, opaque) => {
        receivingContext.operationId = otherOperationId;
        receivingContext.workerId = "next-worker";
        return crypto().open(endpoint, opaque);
      },
    });
    expect(opened.payload).toEqual(expected);
    opened.payload?.fill(0);
  });
});

describe("protected completed agent observations", () => {
  it("transports the model rendition with exact source attribution and rejects another preview lease", async () => {
    const fixture = imageFixture();
    if (fixture.result.status !== "ok" || !("image" in fixture.result.data))
      throw new Error("Invalid fixture");
    const original = fixture.result.data;
    const session = {
      ...original.session,
      binding: {
        ...original.session.binding,
        threadId: "child-thread",
        turnId: "actual-turn",
      },
      target: {
        ...original.session.target!,
        pixelWidth: 2,
        pixelHeight: 2,
        scaleFactor: 2,
      },
      observationRevision: 1,
    };
    const source = {
      sourceId: otherOperationId,
      rootThreadId: "root-thread",
      binding: session.binding,
      target: session.target,
      cursorRevision: session.cursor.revision,
      observationRevision: 1,
      observedAtMs: 100,
    };
    const result = computerUseResultContentSchema.parse({
      status: "ok",
      operation: "agent.observation.get",
      chunkCount: 1,
      data: {
        source,
        session,
        image: original.image,
        nativeImage: {
          ...original.image,
          width: 2,
          height: 2,
          byteCount: 999,
          sha256: "ab".repeat(32),
        },
      },
    });
    const scoped = {
      ...context,
      operation: "agent.observation.get" as const,
      previewLeaseId: otherOperationId,
    };
    const events: ComputerUseChunkEvent[] = [];
    const response = await protectComputerUseResult({
      context: scoped,
      result,
      payload: fixture.payload,
      seal: crypto().seal,
      emit: async (event) => {
        events.push(event);
      },
    });
    const opened = await openComputerUseResult({
      context: scoped,
      opaque: response,
      chunks: events,
      open: crypto().open,
    });
    expect(opened.result).toEqual(result);
    expect(opened.payload).toEqual(fixture.payload);
    expect(JSON.stringify({ response, events })).not.toContain("child-thread");
    expect(JSON.stringify({ response, events })).not.toContain(
      "private-title-fixture",
    );
    await expect(
      openComputerUseResult({
        context: { ...scoped, previewLeaseId: context.operationId },
        opaque: response,
        chunks: events,
        open: crypto().open,
      }),
    ).rejects.toThrow();
    opened.payload?.fill(0);
    fixture.payload.fill(0);
  });
});
