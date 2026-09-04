import { describe, expect, it } from "vitest";
import {
  CUA_REQUIRED_OPERATIONS,
  cuaBindingSchema,
  cuaCapabilitiesSchema,
  cuaCursorAppearanceSchema,
  cuaIdSchema,
  cuaInventorySchema,
  cuaPointSchema,
  cuaScopeSchema,
  cuaSessionSchema,
  cuaSnapshotSchema,
  cuaTargetReferenceSchema,
  cuaTargetSchema,
} from "./types.js";

const appearance = () => ({
  version: 1,
  style: "arrow",
  color: "#20BFA9",
  size: 24,
  label: null,
  trail: false,
  visible: true,
});

const scope = () => ({
  serverId: "server-fixture",
  ownerId: "owner-fixture",
  workerId: "worker-fixture",
  chatId: "chat-fixture",
  taskId: null,
  threadId: null,
  turnId: null,
});

const binding = () => ({
  sessionId: "session-fixture",
  workerId: "worker-fixture",
  chatId: "chat-fixture",
  taskId: null,
  threadId: null,
  turnId: null,
});

const target = () => ({
  id: "window-fixture",
  generation: 1,
  kind: "window",
  title: "Fixture window",
  application: "Fixture application",
  processId: 123,
  bounds: { x: -320, y: -90, width: 320, height: 180 },
  pixelWidth: 640,
  pixelHeight: 360,
  scaleFactor: 2,
  focused: false,
  minimized: false,
});

const session = () => ({
  binding: binding(),
  target: target(),
  cursor: {
    appearance: appearance(),
    position: { x: 12, y: 24 },
    trailPoints: [{ x: 10, y: 20 }],
    updatedAtMs: 1_788_550_000_000,
    revision: 2,
  },
  observationRevision: 1,
});

const snapshot = () => ({
  session: session(),
  image: {
    mediaType: "image/png",
    width: 640,
    height: 360,
    byteCount: 1024,
    sha256: "ab".repeat(32),
    cursorIncluded: true,
  },
});

describe("CUA cursor appearance contract", () => {
  it.each(["arrow", "dot", "ring", "crosshair"])(
    "accepts %s with RGB and RGBA colors and both size limits",
    (style) => {
      for (const color of ["#00aAFF", "#ff000080"])
        for (const size of [8, 96])
          expect(
            cuaCursorAppearanceSchema.safeParse({
              ...appearance(),
              style,
              color,
              size,
            }).success,
          ).toBe(true);
    },
  );

  it.each([null, "", "a".repeat(64), "😀".repeat(64)])(
    "accepts labels bounded by Unicode scalars and UTF-8 bytes: %s",
    (label) => {
      expect(
        cuaCursorAppearanceSchema.safeParse({ ...appearance(), label }).success,
      ).toBe(true);
    },
  );

  it.each([
    { style: "custom" },
    { version: 2 },
    { size: 7 },
    { size: 97 },
    { size: 24.5 },
    { size: Infinity },
    { color: "red" },
    { color: "#123" },
    { color: "#1234567" },
    { color: "#12345G" },
    { color: "#123456789" },
    { label: "a".repeat(65) },
    { label: "😀".repeat(65) },
    { label: "secret\nline" },
    { label: "secret\u0000line" },
    { label: "secret\u0085line" },
    { trail: "true" },
    { visible: 1 },
    { assetUrl: "https://example.com/cursor.svg" },
  ])("rejects invalid appearance fields: %j", (fields) => {
    expect(
      cuaCursorAppearanceSchema.safeParse({ ...appearance(), ...fields })
        .success,
    ).toBe(false);
  });
});

describe("CUA identifiers and native geometry", () => {
  it.each(["fixture", "a".repeat(256), "😀".repeat(64)])(
    "accepts bounded opaque identifiers: %s",
    (id) => {
      expect(cuaIdSchema.safeParse(id).success).toBe(true);
    },
  );
  it.each([
    "",
    "a".repeat(257),
    "😀".repeat(65),
    "id\n",
    "id\u007f",
    "id\u0085",
    null,
    1,
  ])("rejects malformed identifiers: %j", (id) => {
    expect(cuaIdSchema.safeParse(id).success).toBe(false);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, null, "1"])(
    "rejects unsafe target generations: %j",
    (generation) => {
      expect(
        cuaTargetSchema.safeParse({ ...target(), generation }).success,
      ).toBe(false);
      expect(
        cuaTargetReferenceSchema.safeParse({
          targetId: "window-fixture",
          targetGeneration: generation,
        }).success,
      ).toBe(false);
    },
  );
  it("accepts the maximum safe generation and negative monitor origins", () => {
    expect(
      cuaTargetSchema.safeParse({
        ...target(),
        generation: Number.MAX_SAFE_INTEGER,
        kind: "monitor",
        title: null,
        application: null,
        processId: null,
        focused: null,
        minimized: null,
      }).success,
    ).toBe(true);
    expect(
      cuaTargetReferenceSchema.safeParse({
        targetId: "window-fixture",
        targetGeneration: Number.MAX_SAFE_INTEGER,
      }).success,
    ).toBe(true);
  });
  it.each([
    { x: Infinity },
    { y: NaN },
    { width: 0 },
    { width: -1 },
    { height: 0 },
    { height: Infinity },
    { scale: 2 },
  ])("rejects malformed bounds: %j", (fields) => {
    const value = target();
    expect(
      cuaTargetSchema.safeParse({
        ...value,
        bounds: { ...value.bounds, ...fields },
      }).success,
    ).toBe(false);
  });
  it.each([
    { pixelWidth: 0 },
    { pixelHeight: 1.5 },
    { pixelWidth: 0x1_0000_0000 },
    { scaleFactor: 0 },
    { scaleFactor: Infinity },
    { processId: -1 },
    { processId: 0x1_0000_0000 },
    { title: "😀".repeat(1025) },
    { application: "😀".repeat(257) },
    { extra: true },
  ])("rejects invalid native metadata: %j", (fields) => {
    expect(cuaTargetSchema.safeParse({ ...target(), ...fields }).success).toBe(
      false,
    );
  });
  it("accepts title and application UTF-8 boundaries", () => {
    expect(
      cuaTargetSchema.safeParse({
        ...target(),
        title: "😀".repeat(1024),
        application: "😀".repeat(256),
        processId: 0xffff_ffff,
        pixelWidth: 0xffff_ffff,
      }).success,
    ).toBe(true);
  });
  it("requires finite point coordinates and rejects extra point fields", () => {
    expect(cuaPointSchema.safeParse({ x: -1.5, y: 4 }).success).toBe(true);
    for (const point of [
      { x: Infinity, y: 0 },
      { x: 0, y: NaN },
      { x: 1, y: 2, z: 3 },
    ])
      expect(cuaPointSchema.safeParse(point).success).toBe(false);
  });
  it("rejects duplicate IDs across target kinds or generations", () => {
    expect(cuaInventorySchema.safeParse({ targets: [target()] }).success).toBe(
      true,
    );
    expect(
      cuaInventorySchema.safeParse({
        targets: [target(), { ...target(), kind: "monitor", generation: 2 }],
      }).success,
    ).toBe(false);
    const targets = Array.from({ length: 256 }, (_, index) => ({
      ...target(),
      id: `target-${index}`,
    }));
    expect(cuaInventorySchema.safeParse({ targets }).success).toBe(true);
    expect(
      cuaInventorySchema.safeParse({
        targets: [...targets, { ...target(), id: "extra" }],
      }).success,
    ).toBe(false);
  });
});

describe("CUA ownership and observation metadata", () => {
  it("requires explicit scope fields and separates server ownership from native binding", () => {
    expect(cuaScopeSchema.safeParse(scope()).success).toBe(true);
    expect(cuaBindingSchema.safeParse(binding()).success).toBe(true);
    expect(
      cuaBindingSchema.safeParse({ ...binding(), serverId: "server-fixture" })
        .success,
    ).toBe(false);
    expect(
      cuaScopeSchema.safeParse({ ...scope(), ownerId: null }).success,
    ).toBe(false);
    expect(
      cuaScopeSchema.safeParse({ ...scope(), turnId: "bad\nturn" }).success,
    ).toBe(false);
    expect(
      cuaScopeSchema.safeParse({ ...scope(), taskId: undefined }).success,
    ).toBe(false);
  });
  it("bounds cursor trail, timestamp and revision independently", () => {
    const value = session();
    expect(cuaSessionSchema.safeParse(value).success).toBe(true);
    expect(cuaSessionSchema.safeParse({ ...value, target: null }).success).toBe(
      true,
    );
    expect(
      cuaSessionSchema.safeParse({
        ...value,
        cursor: {
          ...value.cursor,
          trailPoints: Array(24).fill({ x: 1, y: 1 }),
          updatedAtMs: 0,
        },
        observationRevision: 0,
      }).success,
    ).toBe(true);
    for (const cursor of [
      { trailPoints: Array(25).fill({ x: 1, y: 1 }) },
      { updatedAtMs: -1 },
      { updatedAtMs: Number.MAX_SAFE_INTEGER + 1 },
      { revision: 0 },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(
        cuaSessionSchema.safeParse({
          ...value,
          cursor: { ...value.cursor, ...cursor },
        }).success,
      ).toBe(false);
  });
  it("accepts bounded PNG metadata including the maximum image area", () => {
    expect(cuaSnapshotSchema.safeParse(snapshot()).success).toBe(true);
    const value = snapshot();
    expect(
      cuaSnapshotSchema.safeParse({
        ...value,
        image: {
          ...value.image,
          width: 2048,
          height: 2048,
          byteCount: 16 * 1024 * 1024,
        },
      }).success,
    ).toBe(true);
  });
  it.each([
    { width: 0 },
    { height: -1 },
    { width: 1.5 },
    { height: Infinity },
    { width: 2048, height: 2049 },
    { width: 4_194_305, height: 1 },
    { byteCount: 0 },
    { byteCount: 16 * 1024 * 1024 + 1 },
    { mediaType: "image/jpeg" },
    { sha256: "ab".repeat(31) },
    { sha256: "AB".repeat(32) },
    { sha256: "gg".repeat(32) },
    { cursorIncluded: false },
    { rawPixels: [] },
  ])("rejects unsupported or inconsistent image metadata: %j", (fields) => {
    const value = snapshot();
    expect(
      cuaSnapshotSchema.safeParse({
        ...value,
        image: { ...value.image, ...fields },
      }).success,
    ).toBe(false);
  });
  it("validates negotiated capabilities without accepting native input or excessive limits", () => {
    const capabilities = {
      protocolVersion: 1,
      runtimeVersion: "0.0.0",
      backend: "fake",
      capture: true,
      nativeInput: false,
      javascript: false,
      cursorAppearanceVersion: 1,
      operations: [...CUA_REQUIRED_OPERATIONS],
      maxSessions: 16,
      maxImageBytes: 16 * 1024 * 1024,
    };
    expect(cuaCapabilitiesSchema.safeParse(capabilities).success).toBe(true);
    for (const fields of [
      { protocolVersion: 2 },
      { nativeInput: true },
      { cursorAppearanceVersion: 2 },
      { maxSessions: 17 },
      { maxImageBytes: 16 * 1024 * 1024 + 1 },
      { operations: Array(33).fill("operation") },
      { backend: "" },
    ])
      expect(
        cuaCapabilitiesSchema.safeParse({ ...capabilities, ...fields }).success,
      ).toBe(false);
  });
});
