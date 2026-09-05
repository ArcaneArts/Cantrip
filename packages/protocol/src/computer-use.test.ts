import { describe, expect, it, vi } from "vitest";

import {
  CUA_CHUNK_BYTES,
  CUA_CONTROL_BYTES,
  CUA_MAX_CHUNKS,
  CUA_REQUIRED_OPERATIONS,
  computerUseActionSchema,
  computerUseChunkEventSchema,
  computerUseHttpResultSchema,
  computerUseRequestSchema,
  computerUseResponseSchema,
  computerUseResultContentSchema,
  cuaBindingSchema,
  cuaCapabilitiesSchema,
  cuaCursorAppearanceSchema,
  cuaIdSchema,
  cuaImageSchema,
  cuaInventorySchema,
  cuaPointSchema,
  cuaScopeSchema,
  cuaSessionSchema,
  cuaTargetSchema,
} from "./computer-use.js";

const operationId = "acfe5a5c-23b9-4dc2-a43b-04acf2d57d64";
const appearance = {
  version: 1,
  style: "arrow",
  color: "#ff000080",
  size: 24,
  label: "Agent 😀",
  trail: true,
  visible: true,
};
const binding = {
  sessionId: "session",
  workerId: "worker",
  chatId: "chat",
  taskId: null,
  threadId: null,
  turnId: null,
};
const target = {
  id: "monitor",
  generation: 1,
  kind: "monitor",
  title: null,
  application: null,
  processId: null,
  bounds: { x: -640, y: -180, width: 640, height: 360 },
  pixelWidth: 1280,
  pixelHeight: 720,
  scaleFactor: 2,
  focused: null,
  minimized: null,
};
const targetRef = { targetId: "monitor", targetGeneration: 1 };
const session = {
  binding,
  target,
  cursor: {
    appearance,
    position: { x: -10, y: 0 },
    trailPoints: [],
    updatedAtMs: 0,
    revision: 1,
  },
  observationRevision: 0,
};
const image = {
  mediaType: "image/png",
  width: 640,
  height: 360,
  byteCount: CUA_CHUNK_BYTES + 1,
  sha256: "ab".repeat(32),
  cursorIncluded: true,
};
const capabilities = {
  protocolVersion: 1,
  runtimeVersion: "0.1.0",
  backend: "fake",
  capture: true,
  nativeInput: false,
  javascript: false,
  cursorAppearanceVersion: 1,
  operations: [...CUA_REQUIRED_OPERATIONS],
  maxSessions: 16,
  maxImageBytes: CUA_CHUNK_BYTES * CUA_MAX_CHUNKS,
};
const actions = [
  { operation: "capabilities.get" },
  { operation: "targets.list" },
  { operation: "session.open", ...targetRef },
  { operation: "session.state", sessionId: "session" },
  { operation: "target.attach", sessionId: "session", ...targetRef },
  { operation: "target.detach", sessionId: "session" },
  {
    operation: "cursor.configure",
    sessionId: "session",
    ...targetRef,
    appearance,
  },
  {
    operation: "cursor.move",
    sessionId: "session",
    ...targetRef,
    position: { x: 0, y: 0 },
  },
  { operation: "observation.snapshot", sessionId: "session", ...targetRef },
  { operation: "session.close", sessionId: "session" },
];

// Canonical unpadded base64url zero bytes need no Node Buffer global.
const opaque = (plaintextBytes = 0) => ({
  formatVersion: 1,
  domain: "client-control-content",
  keyRevision: 1,
  envelope: {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    nonce: "A".repeat(16),
    ciphertext: "A".repeat(Math.ceil(((plaintextBytes + 16) * 4) / 3)),
  },
});
const request = () => ({
  operationId,
  operation: "cursor.move",
  protectedContent: opaque(),
});
const chunk = (sequence = 0) => ({
  type: "computer-use.snapshot.chunk",
  operationId,
  sequence,
  protectedContent: opaque(),
});
const response = () => ({ operationId, protectedContent: opaque() });

describe("browser-compatible CUA geometry and cursor schemas", () => {
  it.each([undefined, false, true])(
    "preserves optional inventory truncation metadata: %s",
    (truncated) => {
      const data = {
        targets: [target],
        ...(truncated === undefined ? {} : { truncated }),
      };
      expect(cuaInventorySchema.parse(data)).toEqual(data);
      expect(
        computerUseResultContentSchema.parse({
          status: "ok",
          operation: "targets.list",
          data,
          chunkCount: 0,
        }),
      ).toMatchObject({ data });
    },
  );
  it.each([null, "true", 1, {}, []])(
    "rejects nonboolean inventory truncation metadata: %j",
    (truncated) => {
      expect(
        cuaInventorySchema.safeParse({ targets: [], truncated }).success,
      ).toBe(false);
    },
  );
  it("validates UTF-8 limits and Unicode labels without a Buffer global", () => {
    vi.stubGlobal("Buffer", undefined);
    try {
      expect(cuaIdSchema.safeParse("😀".repeat(64)).success).toBe(true);
      expect(cuaIdSchema.safeParse("😀".repeat(65)).success).toBe(false);
      expect(
        cuaCursorAppearanceSchema.safeParse({
          ...appearance,
          label: "😀".repeat(64),
        }).success,
      ).toBe(true);
      expect(
        cuaCursorAppearanceSchema.safeParse({
          ...appearance,
          label: "😀".repeat(65),
        }).success,
      ).toBe(false);
      expect(computerUseRequestSchema.safeParse(request()).success).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each(["arrow", "dot", "ring", "crosshair"])(
    "accepts %s with inclusive size bounds",
    (style) => {
      for (const size of [8, 96])
        expect(
          cuaCursorAppearanceSchema.safeParse({ ...appearance, style, size })
            .success,
        ).toBe(true);
    },
  );
  it.each([
    { size: 7 },
    { size: 97 },
    { size: 1.5 },
    { version: 2 },
    { style: "asset" },
    { color: "red" },
    { color: "#123" },
    { label: "x\u0085y" },
    { label: "x\u0000y" },
    { label: "a".repeat(65) },
    { url: "https://example.com/cursor.png" },
  ])("rejects invalid cursor appearance %j", (fields) => {
    expect(
      cuaCursorAppearanceSchema.safeParse({ ...appearance, ...fields }).success,
    ).toBe(false);
  });
  it("preserves negative monitor origins and rejects nonfinite coordinates", () => {
    expect(cuaTargetSchema.safeParse(target).success).toBe(true);
    expect(cuaPointSchema.safeParse({ x: -3, y: 2.5 }).success).toBe(true);
    for (const bad of [Infinity, -Infinity, NaN])
      expect(cuaPointSchema.safeParse({ x: bad, y: 0 }).success).toBe(false);
    expect(
      cuaTargetSchema.safeParse({
        ...target,
        generation: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
    expect(
      cuaTargetSchema.safeParse({
        ...target,
        bounds: { ...target.bounds, width: 0 },
      }).success,
    ).toBe(false);
  });
  it("keeps server authority distinct from native bindings and bounds inventory/session state", () => {
    const { sessionId: _session, ...execution } = binding;
    expect(
      cuaScopeSchema.safeParse({
        ...execution,
        serverId: "server",
        ownerId: "owner",
      }).success,
    ).toBe(true);
    expect(cuaBindingSchema.safeParse(binding).success).toBe(true);
    expect(
      cuaBindingSchema.safeParse({ ...binding, ownerId: "owner" }).success,
    ).toBe(false);
    expect(cuaSessionSchema.safeParse(session).success).toBe(true);
    expect(
      cuaSessionSchema.safeParse({
        ...session,
        cursor: {
          ...session.cursor,
          trailPoints: Array.from({ length: 25 }, () => ({ x: 0, y: 0 })),
        },
      }).success,
    ).toBe(false);
    expect(
      cuaInventorySchema.safeParse({ targets: [target, target] }).success,
    ).toBe(false);
    expect(
      cuaInventorySchema.safeParse({
        targets: Array.from({ length: 257 }, (_, id) => ({
          ...target,
          id: String(id),
        })),
      }).success,
    ).toBe(false);
    expect(cuaCapabilitiesSchema.safeParse(capabilities).success).toBe(true);
    expect(
      cuaCapabilitiesSchema.safeParse({ ...capabilities, nativeInput: true })
        .success,
    ).toBe(false);
  });
});

describe("CUA public and decrypted requests", () => {
  it.each(actions)(
    "accepts the exact action shape for $operation",
    (action) => {
      expect(computerUseActionSchema.safeParse(action).success).toBe(true);
      for (const field of [
        "workerId",
        "ownerId",
        "permission",
        "lifecycle",
        "script",
        "extra",
      ])
        expect(
          computerUseActionSchema.safeParse({ ...action, [field]: "untrusted" })
            .success,
        ).toBe(false);
    },
  );
  it("rejects absent target/session fields and unsupported actions", () => {
    for (const action of [
      { operation: "session.open" },
      { operation: "target.attach", ...targetRef },
      { operation: "cursor.move", sessionId: "session", ...targetRef },
      { operation: "javascript.evaluate", source: "1" },
      { operation: "session.close", sessionId: "" },
    ])
      expect(computerUseActionSchema.safeParse(action).success).toBe(false);
  });
  it("allows only opaque routing fields and bounded control ciphertext", () => {
    expect(
      computerUseRequestSchema.safeParse({
        ...request(),
        protectedContent: opaque(CUA_CONTROL_BYTES),
      }).success,
    ).toBe(true);
    expect(
      computerUseResponseSchema.safeParse({
        ...response(),
        protectedContent: opaque(CUA_CONTROL_BYTES),
      }).success,
    ).toBe(true);
    expect(
      computerUseRequestSchema.safeParse({
        ...request(),
        protectedContent: opaque(CUA_CONTROL_BYTES + 1),
      }).success,
    ).toBe(false);
    expect(
      computerUseResponseSchema.safeParse({
        ...response(),
        protectedContent: opaque(CUA_CONTROL_BYTES + 1),
      }).success,
    ).toBe(false);
    expect(
      computerUseRequestSchema.safeParse({
        ...request(),
        operationId: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      computerUseRequestSchema.safeParse({ ...request(), targetId: "monitor" })
        .success,
    ).toBe(false);
    expect(
      computerUseResponseSchema.safeParse({ ...response(), image }).success,
    ).toBe(false);
  });
  it.each(["run-content", "customization-content", "tunnel-content"])(
    "rejects foreign %s ciphertext on every public envelope",
    (domain) => {
      const protectedContent = { ...opaque(), domain };
      expect(
        computerUseRequestSchema.safeParse({ ...request(), protectedContent })
          .success,
      ).toBe(false);
      expect(
        computerUseResponseSchema.safeParse({ ...response(), protectedContent })
          .success,
      ).toBe(false);
      expect(
        computerUseChunkEventSchema.safeParse({ ...chunk(), protectedContent })
          .success,
      ).toBe(false);
    },
  );
});

describe("bounded CUA snapshot transfer", () => {
  it("allows exactly 64 chunks with inclusive byte and sequence limits", () => {
    expect(
      computerUseChunkEventSchema.safeParse({
        ...chunk(63),
        protectedContent: opaque(CUA_CHUNK_BYTES),
      }).success,
    ).toBe(true);
    expect(
      computerUseChunkEventSchema.safeParse({
        ...chunk(),
        protectedContent: opaque(CUA_CHUNK_BYTES + 1),
      }).success,
    ).toBe(false);
    for (const sequence of [-1, 64, 0.5, Infinity])
      expect(
        computerUseChunkEventSchema.safeParse(chunk(sequence)).success,
      ).toBe(false);
    const chunks = Array.from({ length: 64 }, (_, sequence) => chunk(sequence));
    expect(
      computerUseHttpResultSchema.safeParse({ response: response(), chunks })
        .success,
    ).toBe(true);
    expect(
      computerUseHttpResultSchema.safeParse({
        response: response(),
        chunks: [...chunks, chunk()],
      }).success,
    ).toBe(false);
    expect(
      computerUseChunkEventSchema.safeParse({
        ...chunk(),
        payload: "plaintext image",
      }).success,
    ).toBe(false);
    expect(
      computerUseHttpResultSchema.safeParse({
        response: response(),
        chunks: [],
        screenshot: "plaintext image",
      }).success,
    ).toBe(false);
  });
  it("bounds PNG dimensions, pixel count, bytes, hash and cursor metadata", () => {
    expect(
      cuaImageSchema.safeParse({
        ...image,
        width: 2048,
        height: 2048,
        byteCount: CUA_CHUNK_BYTES * CUA_MAX_CHUNKS,
      }).success,
    ).toBe(true);
    for (const fields of [
      { width: 0 },
      { height: 0.5 },
      { width: 2049, height: 2048 },
      { byteCount: 0 },
      { byteCount: CUA_CHUNK_BYTES * CUA_MAX_CHUNKS + 1 },
      { sha256: "a".repeat(63) },
      { mediaType: "image/jpeg" },
      { cursorIncluded: false },
      { payload: "plaintext image" },
    ])
      expect(cuaImageSchema.safeParse({ ...image, ...fields }).success).toBe(
        false,
      );
  });
});

describe("operation-bound decrypted CUA result metadata", () => {
  it.each(actions)(
    "validates data and chunk count for $operation",
    ({ operation }) => {
      const data =
        operation === "capabilities.get"
          ? capabilities
          : operation === "targets.list"
            ? { targets: [target] }
            : operation === "session.close"
              ? { closed: true }
              : operation === "observation.snapshot"
                ? { session, image }
                : { session };
      const result = {
        status: "ok",
        operation,
        data,
        chunkCount: operation === "observation.snapshot" ? 2 : 0,
      };
      expect(computerUseResultContentSchema.safeParse(result).success).toBe(
        true,
      );
      expect(
        computerUseResultContentSchema.safeParse({ ...result, chunkCount: 1 })
          .success,
      ).toBe(false);
      expect(
        computerUseResultContentSchema.safeParse({
          ...result,
          data: operation === "session.close" ? { session } : { closed: true },
        }).success,
      ).toBe(false);
      expect(
        computerUseResultContentSchema.safeParse({
          ...result,
          payload: "plaintext bytes",
        }).success,
      ).toBe(false);
    },
  );
  it("requires the exact computed snapshot chunk count at both transfer bounds", () => {
    for (const byteCount of [
      1,
      CUA_CHUNK_BYTES,
      CUA_CHUNK_BYTES + 1,
      CUA_CHUNK_BYTES * CUA_MAX_CHUNKS,
    ]) {
      const result = {
        status: "ok",
        operation: "observation.snapshot",
        data: { session, image: { ...image, byteCount } },
        chunkCount: Math.ceil(byteCount / CUA_CHUNK_BYTES),
      };
      expect(computerUseResultContentSchema.safeParse(result).success).toBe(
        true,
      );
      expect(
        computerUseResultContentSchema.safeParse({
          ...result,
          chunkCount: result.chunkCount - 1,
        }).success,
      ).toBe(false);
    }
  });
  it("accepts bounded error metadata, but never chunks or successful result data", () => {
    const error = {
      status: "error",
      operation: "cursor.move",
      code: "permission-denied",
      message: "The operating system denied permission.",
      outcome: "rejected",
    };
    for (const outcome of ["not-sent", "unknown", "rejected"])
      expect(
        computerUseResultContentSchema.safeParse({ ...error, outcome }).success,
      ).toBe(true);
    for (const fields of [
      { outcome: "success" },
      { code: "" },
      { code: "x".repeat(81) },
      { message: "x".repeat(513) },
      { chunkCount: 0 },
      { data: { session } },
    ])
      expect(
        computerUseResultContentSchema.safeParse({ ...error, ...fields })
          .success,
      ).toBe(false);
  });
});
