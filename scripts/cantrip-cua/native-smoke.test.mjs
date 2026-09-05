import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  NativeSmokeError,
  launchNativeFixture,
  parseNativeSmokeArgs,
  smokeNativeCantripCua,
  verifyFixtureGeometry,
  verifyFixturePixels,
  writeNativeScreenshot,
} from "./native-smoke.mjs";
import { CuaOperationError } from "./wire.mjs";

const binary = path.resolve("explicit-stable-cantrip-cua");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6NQAAAAASUVORK5CYII=",
  "base64",
);
const rejectsCode = (code) => (error) => {
  assert.ok(error instanceof NativeSmokeError);
  assert.equal(error.code, code);
  return true;
};

test("native command requires an explicit absolute helper and rejects ambiguous or unsafe arguments", () => {
  assert.deepEqual(parseNativeSmokeArgs(["--help"]), { help: true });
  for (const args of [
    [],
    ["--binary", "relative"],
    ["--binary", `${binary}\0`],
  ]) {
    assert.throws(
      () => parseNativeSmokeArgs(args),
      rejectsCode("absolute-binary-required"),
    );
  }
  for (const args of [["--backend", "fake"], ["--overwrite"], ["extra"]]) {
    assert.throws(
      () => parseNativeSmokeArgs(["--binary", binary, ...args]),
      rejectsCode("invalid-arguments"),
    );
  }
  for (const value of ["0", "-1", "20001", "NaN", "1.5"]) {
    assert.throws(
      () => parseNativeSmokeArgs(["--binary", binary, `--timeout=${value}`]),
      rejectsCode("invalid-deadline"),
    );
  }
  for (const value of ["", "private\ntarget", "a".repeat(257)]) {
    assert.throws(
      () => parseNativeSmokeArgs(["--binary", binary, "--target", value]),
      rejectsCode("invalid-target-id"),
    );
  }
  assert.throws(
    () =>
      parseNativeSmokeArgs([
        "--binary",
        binary,
        "--fixture",
        "--target",
        "macos-window-10",
      ]),
    rejectsCode("fixture-and-target-conflict"),
  );
  assert.throws(
    () =>
      parseNativeSmokeArgs(["--binary", binary, "--output", "relative.png"]),
    rejectsCode("absolute-output-required"),
  );
  const parsed = parseNativeSmokeArgs([
    "--binary",
    binary,
    "--fixture",
    "--output",
    path.resolve("new.png"),
    "--timeout",
    "15000",
  ]);
  assert.equal(parsed.binary, binary);
  assert.equal(parsed.fixture, true);
  assert.equal(parsed.timeoutMs, 15000);
});

test("explicit screenshot output is exclusive and private, and never overwrites existing bytes", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cua-native-output-test-"),
  );
  const filename = path.join(directory, "snapshot.png");
  try {
    await writeNativeScreenshot(filename, png);
    assert.deepEqual(await readFile(filename), png);
    if (process.platform !== "win32")
      assert.equal((await stat(filename)).mode & 0o777, 0o600);
    await assert.rejects(
      writeNativeScreenshot(filename, Buffer.from("replacement")),
      rejectsCode("output-already-exists"),
    );
    assert.deepEqual(await readFile(filename), png);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function raster() {
  const width = 100,
    height = 80;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let color = [255, 0, 0];
      if (x < width * 0.2 && y < height * 0.2) color = [0, 255, 0];
      if (x >= width * 0.8 && y < height * 0.2) color = [255, 255, 0];
      if (x < width * 0.2 && y >= height * 0.8) color = [0, 255, 255];
      if (x >= width * 0.8 && y >= height * 0.8) color = [255, 0, 255];
      data.set([...color, 255], (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

test("fixture samples distinguish correct pixels from vertical flips, channel swaps, and blue occlusion", () => {
  const correct = raster();
  assert.equal(verifyFixturePixels(correct), true);
  const flipped = Buffer.alloc(correct.data.length);
  for (let y = 0; y < correct.height; y++) {
    correct.data.copy(
      flipped,
      y * correct.width * 4,
      (correct.height - y - 1) * correct.width * 4,
      (correct.height - y) * correct.width * 4,
    );
  }
  assert.throws(
    () => verifyFixturePixels({ ...correct, data: flipped }),
    rejectsCode("fixture-pixels-or-orientation-mismatch"),
  );
  const swapped = Buffer.from(correct.data);
  for (let i = 0; i < swapped.length; i += 4)
    [swapped[i], swapped[i + 2]] = [swapped[i + 2], swapped[i]];
  assert.throws(
    () => verifyFixturePixels({ ...correct, data: swapped }),
    rejectsCode("fixture-pixels-or-orientation-mismatch"),
  );
  const covered = Buffer.from(correct.data);
  covered.set([0, 0, 255, 255], (40 * correct.width + 50) * 4);
  assert.throws(
    () => verifyFixturePixels({ ...correct, data: covered }),
    rejectsCode("fixture-pixels-or-orientation-mismatch"),
  );
  for (const value of [
    { ...correct, width: 0 },
    { ...correct, data: Buffer.alloc(1) },
    { ...correct, height: 4_194_304 },
  ]) {
    assert.throws(
      () => verifyFixturePixels(value),
      rejectsCode("invalid-fixture-raster"),
    );
  }
});

test("native fixture geometry is checked against independent coordinates, size and handle generation", () => {
  const previous = {
    id: "macos-window-100",
    generation: 3,
    kind: "window",
    bounds: { x: 20, y: 40, width: 320, height: 240 },
  };
  const state = { x: 48, y: 16, width: 320, height: 240 };
  const moved = { ...previous, bounds: { ...state } };
  verifyFixtureGeometry(moved, state, previous, "move");
  assert.throws(
    () => verifyFixtureGeometry(previous, state, previous, "move"),
    rejectsCode("fixture-geometry-mismatch"),
  );
  assert.throws(
    () =>
      verifyFixtureGeometry(
        { ...moved, generation: 4 },
        state,
        previous,
        "move",
      ),
    rejectsCode("fixture-generation-changed"),
  );
  const incorrectMovement = { ...state, y: 64 };
  assert.throws(
    () =>
      verifyFixtureGeometry(
        { ...moved, bounds: incorrectMovement },
        incorrectMovement,
        previous,
        "move",
      ),
    rejectsCode("fixture-move-mismatch"),
  );
  const resized = {
    ...moved,
    bounds: { x: 48, y: -32, width: 384, height: 288 },
  };
  verifyFixtureGeometry(resized, resized.bounds, moved, "resize");
  assert.throws(
    () =>
      verifyFixtureGeometry(
        { ...resized, bounds: { ...resized.bounds, width: 383.5 } },
        resized.bounds,
        moved,
        "resize",
      ),
    rejectsCode("fixture-geometry-mismatch"),
  );
  assert.throws(
    () => verifyFixtureGeometry(moved, moved.bounds, moved, "resize"),
    rejectsCode("fixture-resize-mismatch"),
  );
});

/** No native helper, permission API, or AppKit process runs in these tests. */
function mockNative({
  fixture = false,
  capabilityOverride,
  failSnapshot,
  closeError,
  captureClosedWindow = false,
  mutateSnapshot,
  cleanupError,
} = {}) {
  let windowId = 100,
    generation = 1,
    bounds = { x: 20, y: 40, width: 320, height: 240 };
  let state = "foreground",
    targetClosed = false,
    session,
    snapshots = 0;
  const requests = [],
    responses = [],
    launches = [],
    writes = [];
  const counters = { closed: 0, disposed: 0, fixtureDisposed: 0, decoded: 0 };
  const fixtureState = () => ({
    windowId: targetClosed ? null : windowId,
    processId: 4242,
    state,
    occluded: state !== "foreground" && !targetClosed,
    ...bounds,
  });
  const target = () => ({
    id: fixture ? `macos-window-${windowId}` : "macos-display-5",
    generation,
    kind: fixture ? "window" : "monitor",
    processId: fixture ? 4242 : null,
    title: "PRIVATE WINDOW TITLE",
    application: "PRIVATE APPLICATION",
    bounds: { ...bounds },
    pixelWidth: 1,
    pixelHeight: 1,
    scaleFactor: 2,
  });
  const result = (data) => ({ data, payload: Buffer.alloc(0) });
  const child = {
    async request(operation) {
      requests.push(operation);
      switch (operation.operation) {
        case "capabilities.get":
          return result({
            protocolVersion: 1,
            backend: "macos-screencapturekit",
            capture: true,
            nativeInput: false,
            cursorAppearanceVersion: 1,
            ...capabilityOverride,
          });
        case "targets.list":
          return result({ targets: [target()] });
        case "target.attach":
          session = {
            binding: operation.binding,
            target: target(),
            cursor: {},
          };
          return result({ session });
        case "cursor.configure":
          session.cursor.appearance = operation.appearance;
          return result({ session });
        case "cursor.move":
          session.cursor.position = operation.position;
          return result({ session });
        case "observation.snapshot": {
          if (targetClosed && !captureClosedWindow)
            throw closeError ?? new CuaOperationError("target-not-found");
          if (failSnapshot) throw failSnapshot;
          snapshots++;
          const payload = Buffer.from(png);
          const data = {
            session: { ...session, target: target() },
            image: {
              mediaType: "image/png",
              cursorIncluded: true,
              width: 1,
              height: 1,
              byteCount: payload.length,
              sha256: createHash("sha256").update(payload).digest("hex"),
            },
          };
          mutateSnapshot?.(data, payload, snapshots);
          const response = { data, payload };
          responses.push(response);
          return response;
        }
        case "session.close":
          return result({ closed: true });
        default:
          throw new Error("Unexpected operation");
      }
    },
    async close() {
      counters.closed++;
    },
    async dispose() {
      counters.disposed++;
      if (cleanupError) throw cleanupError;
    },
  };
  const dependencies = {
    createProcess(...args) {
      launches.push(args);
      return child;
    },
    async launchFixture() {
      return {
        initial: fixtureState(),
        async command(command) {
          switch (command) {
            case "partial":
            case "full":
              state = command;
              break;
            case "move":
              bounds = { ...bounds, x: 48, y: 16 };
              break;
            case "resize":
              bounds = { ...bounds, width: 384, height: 288 };
              break;
            case "close":
              targetClosed = true;
              state = "closed";
              break;
            case "recreate":
              targetClosed = false;
              windowId++;
              generation++;
              state = "foreground";
              break;
            default:
              throw new Error("Unexpected fixture command");
          }
          return fixtureState();
        },
        async dispose() {
          counters.fixtureDisposed++;
        },
      };
    },
    async decodeFixture(payload) {
      assert.deepEqual(payload, png);
      counters.decoded++;
      return true;
    },
    async writeScreenshot(filename, payload) {
      writes.push({ filename, retained: payload, bytes: Buffer.from(payload) });
    },
  };
  return { dependencies, counters, launches, requests, responses, writes };
}

test("explicit native smoke launches only the supplied identity with the default backend and never saves by default", async () => {
  const mock = mockNative();
  const signal = new AbortController().signal;
  const summary = await smokeNativeCantripCua(
    binary,
    { signal },
    mock.dependencies,
  );
  assert.deepEqual(mock.launches, [
    [binary, { args: [], timeoutMs: 20_000, signal }],
  ]);
  assert.equal(summary.backend, "macos-screencapturekit");
  assert.equal(summary.targetKind, "monitor");
  assert.equal(summary.snapshots.length, 1);
  assert.equal(summary.screenshotSaved, false);
  assert.deepEqual(mock.writes, []);
  assert.equal(mock.counters.closed, 1);
  assert.equal(mock.counters.disposed, 1);
  assert.ok(
    mock.responses.every(({ payload }) => payload.every((byte) => byte === 0)),
  );
  assert.doesNotMatch(
    JSON.stringify(summary),
    /PRIVATE|macos-display-5|native-smoke-worker/,
  );
});

test("fixture smoke covers occlusion, geometry changes, stale close, recreate, cursor styles, and clean EOF", async () => {
  const mock = mockNative({ fixture: true });
  const outputPath = path.resolve("user-requested-new.png");
  const summary = await smokeNativeCantripCua(
    binary,
    { fixture: true, outputPath },
    mock.dependencies,
  );
  assert.deepEqual(
    summary.snapshots.map(({ scenario }) => scenario),
    ["foreground", "partial", "full", "move", "resize", "recreated"],
  );
  assert.ok(
    summary.snapshots.every(
      ({ fixturePixelsVerified }) => fixturePixelsVerified,
    ),
  );
  assert.equal(mock.counters.decoded, 6);
  assert.deepEqual(
    new Set(
      mock.requests
        .filter(({ operation }) => operation === "cursor.configure")
        .map(({ appearance }) => appearance.style),
    ),
    new Set(["arrow", "dot", "ring", "crosshair"]),
  );
  assert.equal(
    mock.requests.filter(({ operation }) => operation === "targets.list")
      .length,
    2,
  );
  assert.equal(
    mock.requests.filter(({ operation }) => operation === "target.attach")
      .length,
    2,
  );
  assert.equal(mock.counters.closed, 1);
  assert.equal(mock.counters.disposed, 1);
  assert.equal(mock.counters.fixtureDisposed, 1);
  assert.equal(mock.writes[0].filename, outputPath);
  assert.deepEqual(mock.writes[0].bytes, png);
  assert.ok(mock.writes[0].retained.every((byte) => byte === 0));
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE|macos-window|4242/);
});

test("explicit missing target and unsupported native capability never fall back to a different surface", async () => {
  const missing = mockNative();
  await assert.rejects(
    smokeNativeCantripCua(
      binary,
      { targetId: "macos-window-unknown" },
      missing.dependencies,
    ),
    rejectsCode("requested-target-unavailable"),
  );
  assert.equal(
    missing.requests.some(({ operation }) => operation === "target.attach"),
    false,
  );
  const unsupported = mockNative({ capabilityOverride: { backend: "fake" } });
  await assert.rejects(
    smokeNativeCantripCua(binary, {}, unsupported.dependencies),
    rejectsCode("native-capture-unavailable"),
  );
  assert.deepEqual(unsupported.requests, [{ operation: "capabilities.get" }]);
  assert.equal(unsupported.counters.disposed, 1);
});

test("native permission denial retains only its allowlisted safe code", async () => {
  const mock = mockNative({
    failSnapshot: new CuaOperationError("permission-denied"),
  });
  await assert.rejects(
    smokeNativeCantripCua(binary, {}, mock.dependencies),
    rejectsCode("permission-denied"),
  );
  assert.equal(mock.counters.disposed, 1);
});

test("closed-window transport failures and unrelated native errors cannot count as successful invalidation", async () => {
  for (const [closeError, code] of [
    [new Error("PRIVATE SOCKET DETAIL"), "native-operation-failed"],
    [new CuaOperationError("PRIVATE UNKNOWN CODE"), "unknown-native-error"],
    [new CuaOperationError("capture-failed"), "capture-failed"],
    [new CuaOperationError("permission-denied"), "permission-denied"],
  ]) {
    const mock = mockNative({ fixture: true, closeError });
    await assert.rejects(
      smokeNativeCantripCua(binary, { fixture: true }, mock.dependencies),
      rejectsCode(code),
    );
    assert.equal(
      mock.requests.filter(({ operation }) => operation === "target.attach")
        .length,
      1,
    );
    assert.equal(mock.counters.fixtureDisposed, 1);
  }
  const stale = mockNative({
    fixture: true,
    closeError: new CuaOperationError("stale-target"),
  });
  const summary = await smokeNativeCantripCua(
    binary,
    { fixture: true },
    stale.dependencies,
  );
  assert.equal(summary.snapshots.length, 6);
});

test("a successful capture after fixture close still fails strict target invalidation", async () => {
  const mock = mockNative({ fixture: true, captureClosedWindow: true });
  await assert.rejects(
    smokeNativeCantripCua(binary, { fixture: true }, mock.dependencies),
    rejectsCode("closed-window-was-captured"),
  );
  assert.ok(mock.responses.at(-1).payload.every((byte) => byte === 0));
  assert.equal(mock.counters.fixtureDisposed, 1);
});

test("snapshot digest and metadata tampering fail before decode/output and clear returned bytes", async () => {
  for (const mutateSnapshot of [
    (data) => {
      data.image.sha256 = "0".repeat(64);
    },
    (data) => {
      data.image.width = 2;
    },
    (_data, payload) => {
      payload[0] = 0;
    },
    (data) => {
      data.session.binding = { ...data.session.binding, chatId: "WRONG" };
    },
  ]) {
    const mock = mockNative({ fixture: true, mutateSnapshot });
    await assert.rejects(
      smokeNativeCantripCua(
        binary,
        { fixture: true, outputPath: path.resolve("new.png") },
        mock.dependencies,
      ),
      rejectsCode("native-operation-failed"),
    );
    assert.equal(mock.counters.decoded, 0);
    assert.equal(mock.counters.fixtureDisposed, 1);
    assert.deepEqual(mock.writes, []);
    assert.ok(
      mock.responses.every(({ payload }) =>
        payload.every((byte) => byte === 0),
      ),
    );
  }
});

test("fixture disposal still happens if process cleanup fails", async () => {
  const mock = mockNative({
    fixture: true,
    cleanupError: new Error("cleanup failed"),
  });
  await assert.rejects(
    smokeNativeCantripCua(binary, { fixture: true }, mock.dependencies),
    rejectsCode("native-cleanup-failed"),
  );
  assert.equal(mock.counters.fixtureDisposed, 1);
});

test(
  "actual Swift fixture answers short pipe commands before EOF and closes cleanly",
  {
    // Explicit own-window GUI QA only; ordinary tests never launch AppKit.
    skip: process.env.CANTRIP_CUA_NATIVE_FIXTURE_TEST !== "1",
    timeout: 70_000,
  },
  async () => {
    const fixture = await launchNativeFixture();
    const assertCommitted = (state) => {
      assert.deepEqual(state.windowServerBounds, {
        x: state.x,
        y: state.y,
        width: state.width,
        height: state.height,
      });
    };
    let timer;
    try {
      assertCommitted(fixture.initial);
      const started = performance.now();
      const response = await Promise.race([
        fixture.command("partial"),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error("A short command was not answered before EOF.")),
            2_000,
          );
        }),
      ]);
      clearTimeout(timer);
      assert.equal(response.requestId, 1);
      assert.equal(response.state, "partial");
      assert.ok(performance.now() - started < 2_000);
      assert.equal(response.occluded, true);
      assertCommitted(response);
      assertCommitted(await fixture.command("full"));
      const moved = await fixture.command("move");
      assert.equal(moved.x, response.x + 28);
      assert.equal(moved.y, response.y - 24);
      assertCommitted(moved);
      const resized = await fixture.command("resize");
      assert.equal(resized.width, 384);
      assert.equal(resized.height, 288);
      assertCommitted(resized);
      const closed = await fixture.command("close");
      assert.equal(closed.windowId, null);
      assert.equal(closed.windowServerBounds, null);
      assert.equal(closed.retiredWindowId, resized.windowId);
      assert.equal(closed.retiredWindowPresent, false);
      const recreated = await fixture.command("recreate");
      assert.notEqual(recreated.windowId, closed.retiredWindowId);
      assertCommitted(recreated);
    } finally {
      clearTimeout(timer);
      assert.deepEqual(await fixture.dispose(), { code: 0, signal: null });
    }
  },
);

test("native QA progress contains only bounded scenario and phase metadata", async () => {
  const mock = mockNative({ fixture: true });
  const events = [];
  await smokeNativeCantripCua(
    binary,
    { fixture: true },
    { ...mock.dependencies, onProgress: (event) => events.push(event) },
  );
  assert.ok(events.length > 0 && events.length <= 24);
  assert.equal(events[0].phase, "fixture-start");
  assert.equal(events.at(-1).phase, "session-close");
  assert.equal(
    events.filter(({ phase }) => phase === "snapshot-complete").length,
    6,
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /PRIVATE|macos-window|4242|payload|title/,
  );
});
