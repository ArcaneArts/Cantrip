import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { withInstanceLock } from "./lock.mjs";
import { writeSystemJournal } from "./system-journal.mjs";

const format = "cantrip-os-system-checkpoint";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const imageId = /^sha256:[0-9a-f]{64}$/;
const phases = new Set([
  "reserved",
  "stop-requested",
  "stopped",
  "commit-requested",
  "captured",
  "resume-requested",
  "complete",
]);
const label = (name) => `io.cantrip.os.system.${name}`;

export function systemCheckpointRequest(input) {
  const request = input.request;
  if (
    !request ||
    Object.keys(request).sort().join() !==
      "container,expectedContainerId,instanceId,operationId,resumeOriginal,scopeKey" ||
    typeof request.container !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(request.container) ||
    !uuid.test(request.operationId) ||
    !uuid.test(request.instanceId) ||
    !digest.test(request.expectedContainerId) ||
    !digest.test(request.scopeKey) ||
    typeof request.resumeOriginal !== "boolean"
  )
    throw new Error(
      "An immutable system checkpoint request and exact Docker ID are required.",
    );
  return {
    operationId: request.operationId,
    container: request.container,
    expectedContainerId: request.expectedContainerId,
    instanceId: request.instanceId,
    scopeKey: request.scopeKey,
    resumeOriginal: request.resumeOriginal,
  };
}
const requestHash = (request) =>
  createHash("sha256").update(JSON.stringify(request)).digest("hex");
function labels(record) {
  return {
    [label("operation")]: record.request.operationId,
    [label("request")]: record.requestSha256,
    [label("container")]: record.request.expectedContainerId,
    [label("instance")]: record.request.instanceId,
  };
}
function checkContainer(actual, request) {
  if (
    !actual ||
    actual.Id !== request.expectedContainerId ||
    actual.Config?.Labels?.["io.cantrip.os"] !== "foundation" ||
    typeof actual.State?.Running !== "boolean"
  )
    throw new Error(
      "The exact CantripOS foundation container could not be verified; no replacement was selected.",
    );
  return actual;
}
function checkImage(actual, record) {
  if (
    !actual ||
    !imageId.test(actual.Id) ||
    actual.Os !== "linux" ||
    typeof actual.Architecture !== "string" ||
    !Array.isArray(actual.RootFS?.Layers) ||
    Object.entries(labels(record)).some(
      ([key, value]) => actual.Config?.Labels?.[key] !== value,
    )
  )
    throw new Error(
      "The system image does not match the original checkpoint admission.",
    );
  return actual;
}
async function load(input) {
  let record;
  try {
    record = JSON.parse(await readFile(input.journalPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const request = systemCheckpointRequest(input);
  if (
    record.format !== format ||
    record.version !== 1 ||
    !isDeepStrictEqual(record.request, request) ||
    record.requestSha256 !== requestHash(request) ||
    !phases.has(record.phase) ||
    !["running", "ready", "failed", "unknown"].includes(record.state) ||
    (record.phase !== "reserved" && !record.before) ||
    (record.state === "ready" &&
      (record.phase !== "complete" ||
        !record.snapshot ||
        !record.resumeEvidence)) ||
    (record.snapshot &&
      (!imageId.test(record.snapshot.imageId) ||
        record.snapshot.requestSha256 !== record.requestSha256 ||
        !["acknowledged-and-verified", "observed-labeled-image"].includes(
          record.snapshot.evidence,
        ))) ||
    (record.state === "ready" &&
      (record.request.resumeOriginal && record.before?.State.Running
        ? !["acknowledged-and-observed", "observed-state"].includes(
            record.resumeEvidence,
          )
        : record.resumeEvidence !== "not-requested"))
  )
    throw new Error(
      "The system checkpoint journal changed or belongs to another admission; state was preserved.",
    );
  if (record.before) checkContainer(record.before, request);
  return record;
}
async function save(input, record) {
  record.updatedAt = new Date().toISOString();
  await writeSystemJournal(input.journalPath, record);
}
function snapshot(actual, record, evidence) {
  checkImage(actual, record);
  return {
    format: "cantrip-os-private-system-image",
    version: 1,
    imageId: actual.Id,
    requestSha256: record.requestSha256,
    instanceId: record.request.instanceId,
    sourceContainerId: record.request.expectedContainerId,
    sourceBaseImageId: record.before.Image,
    architecture: actual.Architecture,
    os: actual.Os,
    createdAt: actual.Created,
    size: actual.Size,
    evidence,
    consistency: "stopped-container-filesystem",
    containsPrivateIdentity: true,
    identityPolicy: "same-instance-only",
    runtimeHandlesRestored: false,
    mounts: (record.before.Mounts ?? []).map((mount) => ({
      type: mount.Type,
      source: mount.Name ?? mount.Source ?? null,
      destination: mount.Destination,
      readOnly: !mount.RW,
      included: false,
    })),
    regeneratedPaths: ["/etc/hosts", "/etc/hostname", "/etc/resolv.conf"],
  };
}
async function inspectImage(engine, id, record, signal) {
  return checkImage(
    await engine.request(
      "GET",
      `/images/${encodeURIComponent(id)}/json`,
      undefined,
      { signal },
    ),
    record,
  );
}
async function recoverImage(engine, record, signal) {
  const filters = {
    label: Object.entries(labels(record)).map(
      ([key, value]) => `${key}=${value}`,
    ),
  };
  const candidates = await engine.request(
    "GET",
    `/images/json?all=1&filters=${encodeURIComponent(JSON.stringify(filters))}`,
    undefined,
    { signal },
  );
  if (!Array.isArray(candidates))
    throw new Error("Docker returned no image catalogue.");
  const ids = [...new Set(candidates.map((candidate) => candidate.Id))];
  if (ids.length > 1)
    throw new Error(
      "More than one image claims the original checkpoint; no image was selected.",
    );
  return ids.length ? inspectImage(engine, ids[0], record, signal) : null;
}
async function observe(engine, input, record) {
  let observation = null,
    observationError = null;
  try {
    observation = checkContainer(
      await engine.inspect(record.request.expectedContainerId, {
        signal: input.signal,
      }),
      record.request,
    );
  } catch (error) {
    observationError = error.message;
  }
  if (!["ready", "failed"].includes(record.state)) {
    try {
      let changed = false;
      if (
        record.phase === "stop-requested" &&
        observation &&
        !observation.State.Running
      ) {
        record.phase = "stopped";
        changed = true;
      }
      if (record.phase === "commit-requested") {
        const actual = await recoverImage(engine, record, input.signal);
        if (actual) {
          record.snapshot = snapshot(actual, record, "observed-labeled-image");
          record.phase = "captured";
          changed = true;
        }
      }
      if (
        record.phase === "captured" &&
        (!record.request.resumeOriginal || !record.before.State.Running)
      ) {
        record.resumeEvidence = "not-requested";
        record.phase = "complete";
        record.state = "ready";
        record.error = null;
        changed = true;
      }
      if (
        record.phase === "resume-requested" &&
        observation?.State.Running &&
        record.snapshot
      ) {
        record.resumeEvidence = "observed-state";
        record.phase = "complete";
        record.state = "ready";
        record.error = null;
        changed = true;
      }
      if (changed) {
        if (record.state !== "ready") {
          record.state = "unknown";
          record.error =
            "Original effect observed. Explicit continuation can perform only the remaining unrequested steps.";
        }
        await save(input, record);
      }
    } catch (error) {
      observationError = error.message;
    }
  }
  return { operation: record, observation, observationError };
}
async function advance(engine, input, record) {
  const options = { signal: input.signal, timeout: 300_000 };
  try {
    if (record.phase === "reserved") {
      record.before = checkContainer(
        await engine.inspect(record.request.expectedContainerId, options),
        record.request,
      );
      await save(input, record);
      if (record.before.State.Running) {
        record.phase = "stop-requested";
        await save(input, record);
        await engine.request(
          "POST",
          `/containers/${record.request.expectedContainerId}/stop?t=20`,
          undefined,
          options,
        );
      }
      const stopped = checkContainer(
        await engine.inspect(record.request.expectedContainerId, options),
        record.request,
      );
      if (stopped.State.Running)
        throw new Error(
          "The container is still running; its system image was not captured.",
        );
      record.phase = "stopped";
      await save(input, record);
    }
    if (record.phase === "stopped") {
      const stopped = checkContainer(
        await engine.inspect(record.request.expectedContainerId, options),
        record.request,
      );
      if (stopped.State.Running)
        throw new Error(
          "The original container was restarted outside this checkpoint; no capture was dispatched.",
        );
      record.phase = "commit-requested";
      await save(input, record);
      const configuration = structuredClone(record.before.Config);
      configuration.Labels = { ...configuration.Labels, ...labels(record) };
      const receipt = await engine.request(
        "POST",
        `/commit?container=${record.request.expectedContainerId}&pause=true&repo=cantrip-os-private-system&tag=${record.request.operationId}`,
        configuration,
        options,
      );
      const actual = await inspectImage(
        engine,
        receipt?.Id,
        record,
        input.signal,
      );
      record.snapshot = snapshot(actual, record, "acknowledged-and-verified");
      record.phase = "captured";
      await save(input, record);
    }
    if (record.phase === "captured") {
      // A retained image, not installed helper health, proves capture. Mounts
      // remain separate data and are never silently called part of this image.
      await inspectImage(engine, record.snapshot.imageId, record, input.signal);
      if (record.request.resumeOriginal && record.before.State.Running) {
        record.phase = "resume-requested";
        await save(input, record);
        await engine.request(
          "POST",
          `/containers/${record.request.expectedContainerId}/start`,
          undefined,
          options,
        );
        const actual = checkContainer(
          await engine.inspect(record.request.expectedContainerId, options),
          record.request,
        );
        if (!actual.State.Running)
          throw new Error(
            "The captured original has not resumed; no start was repeated.",
          );
        record.resumeEvidence = "acknowledged-and-observed";
      } else record.resumeEvidence = "not-requested";
      record.phase = "complete";
      record.state = "ready";
      record.error = null;
      await save(input, record);
    }
  } catch (error) {
    record.state = record.phase === "reserved" ? "failed" : "unknown";
    record.error = error.message;
    record.lastError = error.message;
    await save(input, record);
  }
  return observe(engine, input, record);
}

/** New capture reserves before dispatch. Repeating execute only observes. */
function withSystemLock(request, action, signal) {
  return withInstanceLock(
    request.container,
    () => withInstanceLock(request.expectedContainerId, action, { signal }),
    { signal },
  );
}
export async function captureSystemCheckpoint(engine, input) {
  const request = systemCheckpointRequest(input);
  return withSystemLock(
    request,
    async () => {
      const previous = await load(input);
      if (previous) return observe(engine, input, previous);
      const at = new Date().toISOString();
      const record = {
        format,
        version: 1,
        request,
        requestSha256: requestHash(request),
        state: "running",
        phase: "reserved",
        createdAt: at,
        updatedAt: at,
        before: null,
        snapshot: null,
        resumeEvidence: null,
        error: null,
        lastError: null,
      };
      await writeSystemJournal(input.journalPath, record, true);
      return advance(engine, input, record);
    },
    input.signal,
  );
}

export async function observeSystemCheckpoint(engine, input) {
  const request = systemCheckpointRequest(input);
  return withSystemLock(
    request,
    async () => {
      const record = await load(input);
      return record ? observe(engine, input, record) : null;
    },
    input.signal,
  );
}

/** Explicit continuation may send only phases without a prior mutation claim. */
export async function continueSystemCheckpoint(engine, input) {
  const request = systemCheckpointRequest(input);
  return withSystemLock(
    request,
    async () => {
      const record = await load(input);
      if (!record)
        throw new Error("No original system checkpoint admission exists.");
      const result = await observe(engine, input, record);
      if (
        ["ready", "failed"].includes(record.state) ||
        !["reserved", "stopped", "captured"].includes(record.phase)
      )
        return result;
      return advance(engine, input, record);
    },
    input.signal,
  );
}

/** Raw, private system-image bytes for the Worker's encryption/transfer stream.
 * This reads the immutable image; it never commits, uploads or starts anything. */
export async function openSystemCheckpointImage(engine, input) {
  const record = await load(input);
  if (!record?.snapshot)
    throw new Error(
      "No verified system image is recorded for this original operation.",
    );
  await inspectImage(engine, record.snapshot.imageId, record, input.signal);
  return engine.readStream(
    `/images/${encodeURIComponent(record.snapshot.imageId)}/get`,
    { signal: input.signal },
  );
}
