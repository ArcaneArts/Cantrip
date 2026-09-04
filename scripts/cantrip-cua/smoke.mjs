import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

import {
  FramedCuaProcess,
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
} from "./wire.mjs";

const STYLES = ["arrow", "dot", "ring", "crosshair"];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_END = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
const REQUIRED_OPERATIONS = [
  "capabilities.get",
  "targets.list",
  "target.attach",
  "target.detach",
  "cursor.configure",
  "cursor.move",
  "observation.snapshot",
  "session.close",
];

function requireResult(condition, message) {
  if (!condition) throw new Error(`CUA smoke verification failed: ${message}`);
}

function noPayload(response) {
  requireResult(response.payload.length === 0, "unexpected binary payload.");
  return response.data;
}

function sessionMatches(session, binding, target) {
  requireResult(
    isDeepStrictEqual(session?.binding, binding),
    "session binding changed.",
  );
  requireResult(
    session?.target?.id === target.id &&
      session.target.generation === target.generation,
    "selected target changed.",
  );
}

export function verifySnapshot(
  response,
  { binding, target, appearance, position },
) {
  const { data, payload } = response;
  const image = data?.image;
  sessionMatches(data?.session, binding, target);
  requireResult(
    isDeepStrictEqual(data.session.cursor?.appearance, appearance),
    "cursor appearance changed.",
  );
  requireResult(
    isDeepStrictEqual(data.session.cursor?.position, position),
    "cursor position changed.",
  );
  requireResult(
    image?.mediaType === "image/png" &&
      image.cursorIncluded === true &&
      Number.isSafeInteger(image.width) &&
      image.width > 0 &&
      Number.isSafeInteger(image.height) &&
      image.height > 0 &&
      image.width * image.height <= 4_194_304 &&
      image.width === target.pixelWidth &&
      image.height === target.pixelHeight &&
      image.byteCount === payload.length &&
      payload.length >= 45 &&
      payload.length <= MAX_PAYLOAD_BYTES,
    "invalid snapshot metadata.",
  );
  requireResult(
    payload.subarray(0, 8).equals(PNG_SIGNATURE) &&
      payload.readUInt32BE(8) === 13 &&
      payload.toString("ascii", 12, 16) === "IHDR" &&
      payload.readUInt32BE(16) === image.width &&
      payload.readUInt32BE(20) === image.height &&
      payload.subarray(-12).equals(PNG_END),
    "invalid PNG payload or dimensions.",
  );
  const digest = createHash("sha256").update(payload).digest("hex");
  requireResult(
    image.sha256 === digest,
    "snapshot digest did not match its binary payload.",
  );
  return {
    width: image.width,
    height: image.height,
    byteCount: payload.length,
    sha256: digest,
  };
}

/** Launch exactly the provided built/copied binary; no package metadata substitutes for execution. */
export async function smokeCantripCua(
  binary,
  {
    backend = "fake",
    timeoutMs = 15_000,
    cwd,
    env = process.env,
    styles = STYLES,
  } = {},
) {
  if (backend !== "fake")
    throw new Error(
      "This deterministic CUA smoke requires the explicit fake backend.",
    );
  if (
    !Array.isArray(styles) ||
    styles.length === 0 ||
    styles.length > STYLES.length ||
    new Set(styles).size !== styles.length ||
    styles.some((style) => !STYLES.includes(style))
  ) {
    throw new Error(
      "CUA smoke styles must be distinct supported cursor styles.",
    );
  }
  const start = performance.now();
  const child = new FramedCuaProcess(binary, {
    args: ["--backend", backend],
    timeoutMs,
    cwd,
    env,
  });
  const binding = {
    sessionId: "cua-smoke-session",
    workerId: "cua-smoke-worker",
    chatId: "cua-smoke-chat",
    taskId: "cua-smoke-task",
    threadId: "cua-smoke-thread",
    turnId: "cua-smoke-turn",
  };
  const snapshots = [];
  try {
    const capabilities = noPayload(
      await child.request({ operation: "capabilities.get" }),
    );
    requireResult(
      capabilities?.protocolVersion === PROTOCOL_VERSION &&
        capabilities.backend === backend &&
        capabilities.capture === true &&
        capabilities.nativeInput === false &&
        capabilities.cursorAppearanceVersion === 1 &&
        typeof capabilities.runtimeVersion === "string" &&
        Array.isArray(capabilities.operations) &&
        REQUIRED_OPERATIONS.every((operation) =>
          capabilities.operations.includes(operation),
        ),
      "runtime capability handshake did not satisfy the smoke contract.",
    );
    const inventory = noPayload(
      await child.request({ operation: "targets.list" }),
    );
    requireResult(
      Array.isArray(inventory?.targets) &&
        inventory.targets.length === 2 &&
        inventory.targets.some((target) => target.kind === "monitor") &&
        inventory.targets.some((target) => target.kind === "window"),
      "fake monitor/window inventory is missing.",
    );
    for (const target of inventory.targets) {
      requireResult(
        typeof target.id === "string" &&
          target.id.length > 0 &&
          Number.isSafeInteger(target.generation) &&
          target.generation > 0 &&
          Number.isFinite(target.bounds?.width) &&
          target.bounds.width > 0 &&
          Number.isFinite(target.bounds?.height) &&
          target.bounds.height > 0,
        "invalid target geometry or identity.",
      );
      const selected = {
        binding,
        targetId: target.id,
        targetGeneration: target.generation,
      };
      const attached = noPayload(
        await child.request({ operation: "target.attach", ...selected }),
      );
      sessionMatches(attached?.session, binding, target);
      const position = {
        x: target.bounds.width / 2,
        y: target.bounds.height / 2,
      };
      const digests = new Set();
      let appearance;
      for (const style of styles) {
        appearance = {
          version: 1,
          style,
          color: "#39C5BBCC",
          size: 24,
          label: "CUA smoke",
          trail: true,
          visible: true,
        };
        const configured = noPayload(
          await child.request({
            operation: "cursor.configure",
            ...selected,
            appearance,
          }),
        );
        sessionMatches(configured?.session, binding, target);
        requireResult(
          isDeepStrictEqual(configured.session.cursor?.appearance, appearance),
          "cursor customization was not applied.",
        );
        const moved = noPayload(
          await child.request({
            operation: "cursor.move",
            ...selected,
            position,
          }),
        );
        sessionMatches(moved?.session, binding, target);
        requireResult(
          isDeepStrictEqual(moved.session.cursor?.position, position),
          "logical cursor did not move.",
        );
        const snapshot = verifySnapshot(
          await child.request({
            operation: "observation.snapshot",
            ...selected,
          }),
          { binding, target, appearance, position },
        );
        requireResult(
          !digests.has(snapshot.sha256),
          "distinct cursor styles rendered identical images.",
        );
        digests.add(snapshot.sha256);
        snapshots.push({ targetKind: target.kind, style, ...snapshot });
      }
      const repeated = verifySnapshot(
        await child.request({ operation: "observation.snapshot", ...selected }),
        { binding, target, appearance, position },
      );
      requireResult(
        repeated.sha256 === snapshots.at(-1).sha256,
        "unchanged fake snapshot was not deterministic.",
      );
      const detached = noPayload(
        await child.request({ operation: "target.detach", binding }),
      );
      requireResult(
        detached?.session?.target === null,
        "session did not detach.",
      );
    }
    const closed = noPayload(
      await child.request({ operation: "session.close", binding }),
    );
    requireResult(closed?.closed === true, "session did not close.");
    await child.close();
    requireResult(child.eventCount > 0, "runtime emitted no lifecycle events.");
    return {
      protocolVersion: capabilities.protocolVersion,
      runtimeVersion: capabilities.runtimeVersion,
      backend,
      targetCount: inventory.targets.length,
      snapshots,
      eventCount: child.eventCount,
      elapsedMs: Math.round(performance.now() - start),
    };
  } finally {
    await child.dispose();
  }
}

async function main() {
  const { values } = parseArgs({
    options: { binary: { type: "string" }, timeout: { type: "string" } },
    allowPositionals: false,
  });
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const binary =
    values.binary ?? (await import("./build.mjs")).buildCantripCua(root);
  const summary = await smokeCantripCua(binary, {
    timeoutMs: values.timeout === undefined ? 15_000 : Number(values.timeout),
  });
  console.log(JSON.stringify({ status: "passed", ...summary }));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
