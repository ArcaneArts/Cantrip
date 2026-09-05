import { createHash } from "node:crypto";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  adaptCuaModelImages,
  CUA_MODEL_MAX_IMAGE_BYTES,
  CUA_MODEL_MAX_ENCODING_JOBS,
  CUA_MODEL_MAX_PIXELS,
  CUA_MODEL_MAX_TOTAL_BYTES,
  decodeCuaModelImageBase64,
} from "./model-images.js";
import type { CuaSnapshot } from "./types.js";

let small: Buffer;
let noisy: Buffer;
beforeAll(async () => {
  small = await sharp({
    create: { width: 16, height: 10, channels: 4, background: "#ff0080" },
  })
    .png()
    .toBuffer();
  const raw = Buffer.alloc(2000 * 2000 * 4);
  let state = 73;
  for (let i = 0; i < raw.length; i += 4) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    raw.writeUInt32LE(state >>> 0, i);
  }
  noisy = await sharp(raw, { raw: { width: 2000, height: 2000, channels: 4 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
  raw.fill(0);
});
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function snapshot(bytes: Buffer = small): CuaSnapshot {
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return {
    payload: Buffer.from(bytes),
    image: {
      mediaType: "image/png",
      width,
      height,
      byteCount: bytes.length,
      sha256: digest(bytes),
      cursorIncluded: true,
    },
    session: {
      binding: {
        workerId: "worker",
        chatId: "chat",
        taskId: "task",
        threadId: "thread",
        turnId: "turn",
        sessionId: "session",
      },
      target: {
        id: "negative-origin-window",
        generation: 3,
        kind: "window",
        title: "fixture",
        application: null,
        processId: null,
        bounds: { x: -2000, y: -300, width: 1000, height: 500 },
        pixelWidth: width,
        pixelHeight: height,
        scaleFactor: 2,
        focused: false,
        minimized: false,
      },
      cursor: {
        appearance: {
          version: 1,
          style: "crosshair",
          color: "#ff0080",
          size: 24,
          label: "Agent",
          trail: false,
          visible: true,
        },
        position: { x: 12, y: 14 },
        trailPoints: [],
        updatedAtMs: 1,
        revision: 2,
      },
      observationRevision: 5,
    },
  };
}

// Valid unknown ancillary padding chunk, so exact byte boundaries still carry
// a decodable PNG rather than a mocked image encoder or fabricated header.
function padPng(bytes: Buffer, length: number): Buffer {
  const chunk = Buffer.alloc(length - bytes.length);
  chunk.writeUInt32BE(chunk.length - 12, 0);
  chunk.write("caNt", 4, "ascii");
  let crc = 0xffffffff;
  for (const value of chunk.subarray(4, -4)) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return Buffer.concat([bytes.subarray(0, -12), chunk, bytes.subarray(-12)]);
}

describe("CUA model image adapter with actual Sharp", () => {
  it("rejects aggregate native input above 16 MiB before encoding and clears both images", async () => {
    const images = [snapshot(noisy), snapshot(noisy)];
    await expect(adaptCuaModelImages(images)).rejects.toMatchObject({
      code: "capacity",
    });
    for (const image of images)
      expect(image.payload.every((byte) => byte === 0)).toBe(true);
  });
  it("preserves verified PNG bytes and native cursor/negative-origin geometry", async () => {
    const input = snapshot();
    const metadata = structuredClone({
      session: input.session,
      image: input.image,
    });
    const [result] = await adaptCuaModelImages([input]);
    expect(Buffer.from(result!.content.data, "base64")).toEqual(small);
    expect(result!.native).toEqual(metadata);
    expect(result!.model).toEqual({
      width: 16,
      height: 10,
      byteCount: small.length,
      sha256: digest(small),
    });
    expect(result!.content).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    expect(input.payload.every((byte) => byte === 0)).toBe(true);
    expect(input.session).toEqual(metadata.session);
    // Logical midpoint remains target-local even with a negative desktop origin.
    expect(
      (8 * result!.native.session.target!.bounds.width) / result!.model.width,
    ).toBe(500);
  });

  it("preserves PNGs at the exact 2.5 MiB boundary", async () => {
    const bytes = padPng(small, CUA_MODEL_MAX_IMAGE_BYTES);
    const [result] = await adaptCuaModelImages([snapshot(bytes)]);
    expect(Buffer.from(result!.content.data, "base64")).toEqual(bytes);
    expect(result!.model.byteCount).toBe(CUA_MODEL_MAX_IMAGE_BYTES);
  });

  it("decodes the maximum 16 MiB native payload then encodes one bounded rendition", async () => {
    const bytes = padPng(small, 16 * 1024 * 1024);
    const [result] = await adaptCuaModelImages([snapshot(bytes)]);
    expect(result!.native.image.byteCount).toBe(16 * 1024 * 1024);
    expect(result!.model).toMatchObject({ width: 16, height: 10 });
    expect(result!.model.byteCount).toBeLessThan(CUA_MODEL_MAX_IMAGE_BYTES);
  });

  it("resizes two real noisy RGBA captures below image and aggregate transport bounds", async () => {
    const pairInput = await sharp(noisy)
      .extract({ left: 0, top: 0, width: 1400, height: 1400 })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(pairInput.length).toBeGreaterThan(CUA_MODEL_MAX_IMAGE_BYTES);
    expect(pairInput.length * 2).toBeLessThanOrEqual(16 * 1024 * 1024);
    const originals = [snapshot(pairInput), snapshot(pairInput)];
    pairInput.fill(0);
    const results = await adaptCuaModelImages(originals);
    let total = 0;
    for (const result of results) {
      const encoded = decodeCuaModelImageBase64(result.content.data);
      const decoded = await sharp(encoded)
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(result.native.image).toMatchObject({ width: 1400, height: 1400 });
      expect(result.model.width * result.model.height).toBeLessThanOrEqual(
        CUA_MODEL_MAX_PIXELS,
      );
      expect(result.model.width).toBe(result.model.height);
      expect(decoded.info.width).toBe(result.model.width);
      expect(decoded.info.channels).toBe(4);
      expect(encoded.length).toBe(result.model.byteCount);
      expect(digest(encoded)).toBe(result.model.sha256);
      expect(encoded.length).toBeLessThanOrEqual(CUA_MODEL_MAX_IMAGE_BYTES);
      // Full colour, not quantized palette PNG.
      expect(encoded[25]).toBe(6);
      total += encoded.length;
    }
    expect(total).toBeLessThanOrEqual(CUA_MODEL_MAX_TOTAL_BYTES);
    expect(
      originals.every((input) => input.payload.every((byte) => byte === 0)),
    ).toBe(true);
    expect(
      Buffer.byteLength(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: results.map((result) => result.content) },
        }) + "\n",
      ),
    ).toBeLessThan(8 * 1024 * 1024);
  });

  it("bounds a one-pixel thin target without cropping or enlargement", async () => {
    const wide = await sharp({
      create: { width: 700_001, height: 1, channels: 4, background: "#ff0080" },
    })
      .png()
      .toBuffer();
    const [result] = await adaptCuaModelImages([
      snapshot(padPng(wide, CUA_MODEL_MAX_IMAGE_BYTES + 12)),
    ]);
    expect(result!.model).toMatchObject({ width: 600_000, height: 1 });
    expect(result!.native.image).toMatchObject({ width: 700_001, height: 1 });
  });

  it.each([
    "digest",
    "dimensions",
    "byteCount",
    "signature",
    "nativeBytes",
    "pixels",
    "truncated",
  ])("rejects malformed %s and clears the input", async (kind) => {
    const input = snapshot();
    if (kind === "digest") input.image.sha256 = "0".repeat(64);
    if (kind === "dimensions") input.image.width++;
    if (kind === "byteCount") input.image.byteCount++;
    if (kind === "signature") input.payload[0] = 0;
    if (kind === "nativeBytes") {
      input.payload = Buffer.alloc(16 * 1024 * 1024 + 1);
      input.image.byteCount = input.payload.length;
    }
    if (kind === "pixels") {
      input.image.width = 4_194_304;
      input.image.height = 2;
    }
    if (kind === "truncated") {
      input.payload = input.payload.subarray(0, 34);
      input.image.byteCount = input.payload.length;
      input.image.sha256 = digest(input.payload);
    }
    await expect(adaptCuaModelImages([input])).rejects.toMatchObject({
      code: "protocol-error",
    });
    expect(input.payload.every((byte) => byte === 0)).toBe(true);
  });

  it("rejects three images and clears every input without publishing a partial result", async () => {
    const inputs = [snapshot(), snapshot(), snapshot()];
    await expect(adaptCuaModelImages(inputs)).rejects.toMatchObject({
      code: "capacity",
    });
    expect(
      inputs.every((input) => input.payload.every((byte) => byte === 0)),
    ).toBe(true);
  });

  it("cancels an active Sharp encode promptly and clears its late buffers", async () => {
    const input = snapshot(noisy);
    const controller = new AbortController();
    const original = sharp.prototype.toBuffer;
    let started!: () => void;
    const encoding = new Promise<void>((resolve) => {
      started = resolve;
    });
    let nativeEncode!: Promise<{ data: Buffer }>;
    const encodeSpy = vi
      .spyOn(sharp.prototype, "toBuffer")
      .mockImplementation(function (this: sharp.Sharp, ...args: unknown[]) {
        nativeEncode = original.apply(this, args);
        started();
        return nativeEncode;
      });
    const pending = adaptCuaModelImages([input], controller.signal);
    await encoding;
    encodeSpy.mockRestore();
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "cancelled",
      outcome: "unknown",
    });
    const late = await nativeEncode;
    expect(late.data.every((byte: number) => byte === 0)).toBe(true);
    await vi.waitFor(
      () => expect(input.payload.every((byte) => byte === 0)).toBe(true),
      { timeout: 5000 },
    );
  });

  it("retains bounded decoder ownership after cancellation until actual native work settles", async () => {
    const original = sharp.prototype.toBuffer;
    let release!: () => void;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const nativeOutputs: Buffer[] = [];
    let starts = 0;
    const spy = vi
      .spyOn(sharp.prototype, "toBuffer")
      .mockImplementation(function (this: sharp.Sharp, ...args: unknown[]) {
        const pending: Promise<{ data: Buffer }> = original.apply(this, args);
        if (++starts === CUA_MODEL_MAX_ENCODING_JOBS) started();
        return pending.then(async (result) => {
          nativeOutputs.push(result.data);
          // Delay the observed completion of genuine Sharp decoding. This models
          // libvips queue delay without replacing the decoder or guessing timing.
          await completion;
          return result;
        });
      });
    const inputs = Array.from({ length: CUA_MODEL_MAX_ENCODING_JOBS }, () =>
      snapshot(),
    );
    const controllers = inputs.map(() => new AbortController());
    const calls = inputs.map((input, index) =>
      adaptCuaModelImages([input], controllers[index]!.signal).catch(
        (error: unknown) => error,
      ),
    );
    try {
      await allStarted;
      controllers.forEach((controller) => controller.abort());
      for (const result of await Promise.all(calls))
        expect(result).toMatchObject({ code: "cancelled" });
      const excess = snapshot();
      await expect(adaptCuaModelImages([excess])).rejects.toMatchObject({
        code: "capacity",
      });
      expect(excess.payload.every((byte) => byte === 0)).toBe(true);
      expect(starts).toBe(CUA_MODEL_MAX_ENCODING_JOBS);
      // Image-free calls neither allocate nor wait for decoder capacity.
      await expect(adaptCuaModelImages([])).resolves.toEqual([]);
      release();
      await vi.waitFor(() =>
        expect(
          inputs.every((input) => input.payload.every((byte) => byte === 0)),
        ).toBe(true),
      );
      expect(nativeOutputs).toHaveLength(CUA_MODEL_MAX_ENCODING_JOBS);
      expect(
        nativeOutputs.every((bytes) => bytes.every((byte) => byte === 0)),
      ).toBe(true);
    } finally {
      controllers.forEach((controller) => controller.abort());
      release();
      spy.mockRestore();
    }
    const [result] = await adaptCuaModelImages([snapshot()]);
    expect(Buffer.from(result!.content.data, "base64")).toEqual(small);
  });

  it("cancels before admission and keeps already-delivered model strings intact", async () => {
    const controller = new AbortController();
    const [result] = await adaptCuaModelImages([snapshot()], controller.signal);
    controller.abort();
    expect(Buffer.from(result!.content.data, "base64")).toEqual(small);
    const input = snapshot();
    await expect(
      adaptCuaModelImages([input], controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(input.payload.every((byte) => byte === 0)).toBe(true);
  });
});

describe("CUA image base64 boundary", () => {
  it.each([
    "",
    "Zg",
    "Zg=",
    "Zg===",
    "Zg==\n",
    "Zg--",
    "Zg__",
    "Zh==",
    "Zm9=",
    "a".repeat(4 * Math.ceil(CUA_MODEL_MAX_IMAGE_BYTES / 3) + 4),
  ])("rejects noncanonical or oversized input %#", (data) => {
    expect(() => decodeCuaModelImageBase64(data)).toThrow();
  });
  it("accepts canonical base64 and checks decoded length at the rounded boundary", () => {
    expect(decodeCuaModelImageBase64("Zg==")).toEqual(Buffer.from("f"));
    expect(() =>
      decodeCuaModelImageBase64(
        Buffer.alloc(CUA_MODEL_MAX_IMAGE_BYTES + 1).toString("base64"),
      ),
    ).toThrow();
  });
});
