import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

import {
  CuaOperationError,
  FramedCuaProcess,
  PROTOCOL_VERSION,
} from "./wire.mjs";
import { verifySnapshot } from "./smoke.mjs";

const STYLES = ["arrow", "dot", "ring", "crosshair"];
const fixtureSource = fileURLToPath(
  new URL("./native-fixture.swift", import.meta.url),
);
const requireWorker = createRequire(
  new URL("../../cantrip_worker/package.json", import.meta.url),
);

export class NativeSmokeError extends Error {
  constructor(code) {
    super(`Native CUA smoke failed: ${code}.`);
    this.name = "NativeSmokeError";
    this.code = code;
  }
}
function requireResult(condition, code) {
  if (!condition) throw new NativeSmokeError(code);
}

function optionsFor(binary, options) {
  requireResult(
    typeof binary === "string" &&
      path.isAbsolute(binary) &&
      !binary.includes("\0"),
    "absolute-binary-required",
  );
  const {
    targetId,
    outputPath,
    fixture = false,
    timeoutMs = 20_000,
    signal,
  } = options;
  requireResult(
    Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 20_000,
    "invalid-deadline",
  );
  requireResult(typeof fixture === "boolean", "invalid-fixture-option");
  requireResult(
    targetId === undefined ||
      (typeof targetId === "string" &&
        Buffer.byteLength(targetId) <= 256 &&
        targetId.length > 0 &&
        !/\p{Cc}/u.test(targetId)),
    "invalid-target-id",
  );
  requireResult(
    !fixture || targetId === undefined,
    "fixture-and-target-conflict",
  );
  requireResult(
    outputPath === undefined ||
      (typeof outputPath === "string" &&
        path.isAbsolute(outputPath) &&
        !outputPath.includes("\0")),
    "absolute-output-required",
  );
  return { targetId, outputPath, fixture, timeoutMs, signal };
}

export function parseNativeSmokeArgs(args) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      options: {
        binary: { type: "string" },
        target: { type: "string" },
        output: { type: "string" },
        fixture: { type: "boolean", default: false },
        timeout: { type: "string" },
        help: { type: "boolean", default: false },
      },
    }));
  } catch {
    throw new NativeSmokeError("invalid-arguments");
  }
  if (values.help) return { help: true };
  return {
    binary: values.binary,
    ...optionsFor(values.binary, {
      targetId: values.target,
      outputPath: values.output,
      fixture: values.fixture,
      timeoutMs: values.timeout === undefined ? 20_000 : Number(values.timeout),
    }),
  };
}

export async function writeNativeScreenshot(outputPath, payload) {
  requireResult(
    path.isAbsolute(outputPath) && Buffer.isBuffer(payload),
    "invalid-output",
  );
  let file;
  try {
    file = await open(outputPath, "wx", 0o600);
    await file.writeFile(payload);
    await file.sync();
  } catch (error) {
    throw new NativeSmokeError(
      error.code === "EEXIST" ? "output-already-exists" : "output-write-failed",
    );
  } finally {
    await file?.close();
  }
}

/** Top-left RGBA rows: four different corners catch vertical flips and swaps. */
export function verifyFixturePixels({ data, width, height }) {
  requireResult(
    Buffer.isBuffer(data) &&
      Number.isInteger(width) &&
      width >= 16 &&
      Number.isInteger(height) &&
      height >= 16 &&
      width * height <= 4_194_304 &&
      data.length === width * height * 4,
    "invalid-fixture-raster",
  );
  const patches = [
    [0.1, 0.1, [0, 255, 0]],
    [0.9, 0.1, [255, 255, 0]],
    [0.1, 0.9, [0, 255, 255]],
    [0.9, 0.9, [255, 0, 255]],
    [0.5, 0.5, [255, 0, 0]],
  ];
  for (const [x, y, color] of patches) {
    const offset = (Math.floor(y * height) * width + Math.floor(x * width)) * 4;
    requireResult(
      color.every(
        (value, channel) => Math.abs(data[offset + channel] - value) <= 40,
      ) && data[offset + 3] >= 230,
      "fixture-pixels-or-orientation-mismatch",
    );
  }
  return true;
}

/** Compare native post-capture geometry with the fixture's actual AppKit frame,
 * not just image metadata copied from the same native response. */
export function verifyFixtureGeometry(target, state, previous, scenario) {
  const close = (actual, expected) =>
    Number.isFinite(actual) &&
    Number.isFinite(expected) &&
    Math.abs(actual - expected) < 0.01;
  requireResult(
    target?.kind === "window" &&
      ["x", "y", "width", "height"].every((key) =>
        close(target.bounds?.[key], state[key]),
      ),
    "fixture-geometry-mismatch",
  );
  if (["move", "resize"].includes(scenario)) {
    requireResult(
      target.id === previous.id && target.generation === previous.generation,
      "fixture-generation-changed",
    );
  }
  if (scenario === "move") {
    requireResult(
      close(target.bounds.x, previous.bounds.x + 28) &&
        close(target.bounds.y, previous.bounds.y - 24),
      "fixture-move-mismatch",
    );
  }
  if (scenario === "resize") {
    requireResult(
      close(target.bounds.width, 384) && close(target.bounds.height, 288),
      "fixture-resize-mismatch",
    );
  }
}

async function decodeFixture(payload) {
  const sharp = requireWorker("sharp");
  const { data, info } = await sharp(payload, { limitInputPixels: 4_194_304 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  try {
    return verifyFixturePixels({
      data,
      width: info.width,
      height: info.height,
    });
  } finally {
    data.fill(0);
  }
}

/** Only explicit fixture mode compiles/launches this owned AppKit app. */
export async function launchNativeFixture({
  signal,
  lifetimeMs = 20_000,
} = {}) {
  requireResult(
    Number.isInteger(lifetimeMs) && lifetimeMs >= 1 && lifetimeMs <= 300_000,
    "invalid-fixture-lifetime",
  );
  const directory = await mkdtemp(
    path.join(tmpdir(), "cantrip-cua-native-fixture-"),
  );
  const executable = path.join(directory, "fixture");
  try {
    requireResult(!signal?.aborted, "cancelled");
    const build = spawnSync(
      "xcrun",
      [
        "swiftc",
        "-parse-as-library",
        fixtureSource,
        "-o",
        executable,
        "-framework",
        "AppKit",
      ],
      { timeout: 60_000, maxBuffer: 65_536, stdio: ["ignore", "pipe", "pipe"] },
    );
    requireResult(!build.error && build.status === 0, "fixture-build-failed");
    requireResult(!signal?.aborted, "cancelled");
    const child = spawn(executable, ["--lifetime-ms", String(lifetimeMs)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let requestId = 0,
      buffered = "",
      stderrBytes = 0,
      failed = false;
    const pending = new Map();
    let readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const fail = () => {
      if (failed) return;
      failed = true;
      const error = new NativeSmokeError("fixture-unavailable");
      readyReject(error);
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      child.kill("SIGTERM");
    };
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.stderr.on("data", (data) => {
      stderrBytes += data.length;
      if (stderrBytes > 65_536) fail();
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      buffered += data;
      if (Buffer.byteLength(buffered) > 8192) {
        fail();
        return;
      }
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          const state = JSON.parse(line);
          requireResult(
            state.version === 1 &&
              state.status === "ok" &&
              Number.isInteger(state.processId) &&
              state.processId === child.pid &&
              (state.windowId === null ||
                (Number.isInteger(state.windowId) && state.windowId > 0)) &&
              Number.isInteger(state.requestId) &&
              ["foreground", "partial", "full", "closed"].includes(
                state.state,
              ) &&
              typeof state.occluded === "boolean",
            "invalid-fixture-response",
          );
          if (state.requestId === 0) readyResolve(state);
          else {
            const waiter = pending.get(state.requestId);
            requireResult(waiter, "invalid-fixture-correlation");
            pending.delete(state.requestId);
            waiter.resolve(state);
          }
        } catch {
          fail();
        }
      }
    });
    const exit = new Promise((resolve) =>
      child.once("close", (code, signal) => {
        fail();
        resolve({ code, signal });
      }),
    );
    const abort = () => fail();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) fail();
    const timeout = setTimeout(fail, lifetimeMs);
    async function dispose() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      child.stdin.end();
      const kill = setTimeout(() => child.kill("SIGKILL"), 500);
      const outcome = await exit;
      clearTimeout(kill);
      await rm(directory, { recursive: true, force: true });
      return outcome;
    }
    try {
      const initial = await ready;
      return {
        initial,
        command(command) {
          requireResult(
            !failed && requestId < 64 && pending.size === 0,
            "fixture-command-unavailable",
          );
          const id = ++requestId;
          return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            child.stdin.write(
              `${JSON.stringify({ requestId: id, command })}\n`,
            );
          });
        },
        dispose,
      };
    } catch (error) {
      await dispose();
      throw error;
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Explicit manual native action. Never builds, signs, or switches helper identity. */
export async function smokeNativeCantripCua(
  binary,
  input = {},
  dependencies = {},
) {
  const options = optionsFor(binary, input);
  const started = performance.now();
  const progress = (phase, scenario) => {
    dependencies.onProgress?.({
      event: "native-cua-smoke-progress",
      phase,
      ...(scenario ? { scenario } : {}),
      elapsedMs: Math.round(performance.now() - started),
    });
  };
  let fixture, child, lastPayload;
  const snapshots = [];
  const binding = {
    sessionId: randomUUID(),
    workerId: "native-smoke-worker",
    chatId: "native-smoke-chat",
    taskId: null,
    threadId: null,
    turnId: null,
  };
  const noPayload = (response) => {
    if (response.payload.length !== 0) {
      response.payload.fill(0);
      throw new NativeSmokeError("unexpected-payload");
    }
    return response.data;
  };
  try {
    if (options.fixture) {
      progress("fixture-start");
      fixture = await (dependencies.launchFixture ?? launchNativeFixture)(
        options,
      );
    }
    child = (
      dependencies.createProcess ?? ((...args) => new FramedCuaProcess(...args))
    )(binary, {
      args: [],
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    progress("handshake");
    const capabilities = noPayload(
      await child.request({ operation: "capabilities.get" }),
    );
    requireResult(
      capabilities?.protocolVersion === PROTOCOL_VERSION &&
        capabilities.backend === "macos-screencapturekit" &&
        capabilities.capture === true &&
        capabilities.nativeInput === false &&
        capabilities.cursorAppearanceVersion === 1,
      "native-capture-unavailable",
    );
    const findTarget = async (state) => {
      let after,
        total = 0;
      for (let page = 1; page <= 64; page++) {
        progress("inventory");
        const inventory = noPayload(
          await child.request({
            operation: "targets.list",
            ...(after ? { after } : {}),
          }),
        );
        const { targets, truncated, nextCursor } = inventory ?? {};
        requireResult(
          Array.isArray(targets) && targets.length <= 256,
          "invalid-inventory",
        );
        total += targets.length;
        requireResult(total <= 4096, "inventory-pagination-limit");
        const hasNext = nextCursor !== undefined && nextCursor !== null;
        if (hasNext)
          requireResult(
            typeof nextCursor === "string" &&
              Buffer.byteLength(nextCursor) <= 256 &&
              nextCursor.length > 0 &&
              targets.length > 0 &&
              nextCursor === targets.at(-1)?.id &&
              (!after || nextCursor > after),
            "invalid-inventory-cursor",
          );
        if (state) {
          const requestedTargetId = `macos-window-${state.windowId}`;
          const candidate = targets.find(
            (target) => target.id === requestedTargetId,
          );
          const processMatched = candidate?.processId === state.processId;
          const generationValid =
            processMatched &&
            Number.isSafeInteger(candidate.generation) &&
            candidate.generation > 0;
          dependencies.onDiscovery?.({
            event: "native-cua-fixture-discovery",
            page,
            inventoryCount: targets.length,
            totalCount: total,
            hasNext,
            truncated: typeof truncated === "boolean" ? truncated : null,
            requestedTargetId,
            idMatched: Boolean(candidate),
            processMatched,
            windowMatched: candidate?.kind === "window",
            generationValid,
            generation: generationValid ? candidate.generation : null,
          });
        }
        const selected = state
          ? targets.find(
              (target) =>
                target.id === `macos-window-${state.windowId}` &&
                target.processId === state.processId &&
                target.kind === "window",
            )
          : options.targetId
            ? targets.find((target) => target.id === options.targetId)
            : targets.find((target) => target.kind === "monitor");
        if (selected) {
          requireResult(
            typeof selected.id === "string" &&
              Number.isSafeInteger(selected.generation) &&
              selected.generation > 0,
            "requested-target-unavailable",
          );
          return selected;
        }
        if (!hasNext) return null;
        after = nextCursor;
      }
      throw new NativeSmokeError("inventory-pagination-limit");
    };
    let target = await findTarget(fixture?.initial);
    requireResult(target, "requested-target-unavailable");
    const attach = async () => {
      const result = noPayload(
        await child.request({
          operation: "target.attach",
          binding,
          targetId: target.id,
          targetGeneration: target.generation,
        }),
      );
      requireResult(
        isDeepStrictEqual(result?.session?.binding, binding) &&
          result.session.target?.id === target.id &&
          result.session.target.generation === target.generation,
        "invalid-attachment",
      );
    };
    await attach();
    async function snapshot(scenario, state) {
      progress("snapshot-start", scenario);
      if (state && ["partial", "full"].includes(state.state))
        requireResult(state.occluded, "fixture-not-occluded");
      const selected = {
        binding,
        targetId: target.id,
        targetGeneration: target.generation,
      };
      const appearance = {
        version: 1,
        style: STYLES[snapshots.length % STYLES.length],
        color: "#FFFFFF",
        size: 20,
        label: null,
        trail: false,
        visible: true,
      };
      const position = {
        x: target.bounds.width * 0.3,
        y: target.bounds.height * 0.5,
      };
      noPayload(
        await child.request({
          operation: "cursor.configure",
          ...selected,
          appearance,
        }),
      );
      noPayload(
        await child.request({
          operation: "cursor.move",
          ...selected,
          position,
        }),
      );
      const start = performance.now();
      const response = await child.request({
        operation: "observation.snapshot",
        ...selected,
      });
      try {
        const current = response.data?.session?.target;
        requireResult(
          current?.id === target.id && current.generation === target.generation,
          "snapshot-target-changed",
        );
        if (fixture) verifyFixtureGeometry(current, state, target, scenario);
        const metadata = verifySnapshot(response, {
          binding,
          target: current,
          appearance,
          position,
        });
        if (fixture)
          await (dependencies.decodeFixture ?? decodeFixture)(response.payload);
        snapshots.push({
          scenario,
          width: metadata.width,
          height: metadata.height,
          byteCount: metadata.byteCount,
          elapsedMs: Math.round(performance.now() - start),
          fixturePixelsVerified: Boolean(fixture),
        });
        if (options.outputPath) {
          lastPayload?.fill(0);
          lastPayload = Buffer.from(response.payload);
        }
        target = current;
        progress("snapshot-complete", scenario);
      } finally {
        response.payload.fill(0);
      }
    }
    await snapshot("foreground", fixture?.initial);
    if (fixture) {
      for (const command of ["partial", "full", "move", "resize"])
        await snapshot(command, await fixture.command(command));
      progress("fixture-command", "close");
      await fixture.command("close");
      requireResult(
        !(await findTarget(fixture.initial)),
        "closed-window-still-listed",
      );
      let rejected = false;
      try {
        const unexpected = await child.request({
          operation: "observation.snapshot",
          binding,
          targetId: target.id,
          targetGeneration: target.generation,
        });
        unexpected.payload.fill(0);
      } catch (error) {
        if (
          error instanceof CuaOperationError &&
          ["target-not-found", "stale-target"].includes(error.code)
        )
          rejected = true;
        else throw error;
      }
      requireResult(rejected, "closed-window-was-captured");
      progress("fixture-command", "recreate");
      const state = await fixture.command("recreate");
      const replacement = await findTarget(state);
      requireResult(replacement, "requested-target-unavailable");
      requireResult(
        replacement.id !== target.id ||
          replacement.generation !== target.generation,
        "closed-window-handle-reused",
      );
      target = replacement;
      await attach();
      await snapshot("recreated", state);
    }
    progress("session-close");
    requireResult(
      noPayload(await child.request({ operation: "session.close", binding }))
        ?.closed === true,
      "session-close-not-confirmed",
    );
    await child.close();
    if (options.outputPath)
      await (dependencies.writeScreenshot ?? writeNativeScreenshot)(
        options.outputPath,
        lastPayload,
      );
    return {
      backend: capabilities.backend,
      protocolVersion: PROTOCOL_VERSION,
      targetKind: target.kind,
      snapshots,
      screenshotSaved: Boolean(options.outputPath),
      elapsedMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    throw error instanceof NativeSmokeError
      ? error
      : new NativeSmokeError(
          error instanceof CuaOperationError
            ? error.code
            : "native-operation-failed",
        );
  } finally {
    lastPayload?.fill(0);
    try {
      try {
        await child?.dispose();
      } finally {
        await fixture?.dispose();
      }
    } catch {
      throw new NativeSmokeError("native-cleanup-failed");
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const options = parseNativeSmokeArgs(process.argv.slice(2));
    if (options.help)
      console.log(
        "Usage: node scripts/cantrip-cua/native-smoke.mjs --binary /absolute/stable/cantrip-cua [--target ID | --fixture] [--output /absolute/new.png] [--timeout 20000]\nExplicit native capture; no screenshot file is saved without --output. Existing output files are never overwritten.",
      );
    else {
      const summary = await smokeNativeCantripCua(options.binary, options, {
        onProgress: (event) => console.log(`QA_EVT ${JSON.stringify(event)}`),
        onDiscovery: (event) => console.log(`QA_EVT ${JSON.stringify(event)}`),
      });
      console.log(
        `QA_EVT ${JSON.stringify({ event: "native-cua-smoke", status: "pass", ...summary })}`,
      );
    }
  } catch (error) {
    console.error(
      `QA_EVT ${JSON.stringify({ event: "native-cua-smoke", status: "fail", code: error instanceof NativeSmokeError ? error.code : "native-operation-failed" })}`,
    );
    process.exitCode = 1;
  }
}
