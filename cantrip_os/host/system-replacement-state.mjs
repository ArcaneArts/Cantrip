import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { DockerApiError } from "./docker.mjs";
import { writeSystemJournal } from "./system-journal.mjs";
import { withInstanceLock } from "./lock.mjs";
import { imageDefaults, sourceMountsLabel } from "./image-defaults.mjs";
import { mountedConfiguration, sourceMounts } from "./mounts.mjs";

export const format = "cantrip-os-retained-system-replacement";
export const noRestart = { Name: "no", MaximumRetryCount: 0 };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const imageId = /^sha256:[a-f0-9]{64}$/;
export const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const label = (name) => `io.cantrip.os.replacement.${name}`;
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join() === keys.sort().join();
export function replacementRequest(input) {
  const r = input.request;
  const common = [
    "action",
    "operationId",
    "container",
    "instanceId",
    "scopeKey",
    "startTarget",
  ];
  if (
    !r ||
    !uuid.test(r.operationId) ||
    !uuid.test(r.instanceId) ||
    !digest.test(r.scopeKey) ||
    typeof r.container !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(r.container) ||
    typeof r.startTarget !== "boolean"
  )
    throw new Error("An immutable system replacement admission is required.");
  if (r.action === "replace") {
    if (
      !exact(r, [...common, "expectedContainerId", "source", "archive"]) ||
      !digest.test(r.expectedContainerId)
    )
      throw new Error(
        "The replacement requires its exact original Docker identity.",
      );
    const s = r.source;
    if (
      !s ||
      !imageId.test(s.imageId) ||
      !(
        (s.kind === "base" && exact(s, ["kind", "imageId"])) ||
        (s.kind === "checkpoint" &&
          exact(s, [
            "kind",
            "imageId",
            "operationId",
            "requestSha256",
            "containerId",
          ]) &&
          uuid.test(s.operationId) &&
          digest.test(s.requestSha256) &&
          digest.test(s.containerId))
      )
    )
      throw new Error(
        "An exact base or same-instance checkpoint image proof is required.",
      );
    if (
      r.archive !== null &&
      (!exact(r.archive, ["path", "bytes", "sha256"]) ||
        typeof r.archive.path !== "string" ||
        !r.archive.path ||
        r.archive.path.includes("\0") ||
        !Number.isSafeInteger(r.archive.bytes) ||
        r.archive.bytes <= 0 ||
        !digest.test(r.archive.sha256))
    )
      throw new Error("A verified staged archive descriptor is required.");
  } else if (r.action === "rollback") {
    if (
      !exact(r, [
        ...common,
        "replacementOperationId",
        "replacementRequestSha256",
        "expectedOriginalId",
      ]) ||
      !uuid.test(r.replacementOperationId) ||
      !digest.test(r.replacementRequestSha256) ||
      !digest.test(r.expectedOriginalId)
    )
      throw new Error("Rollback requires its original replacement admission.");
  } else throw new Error("Unknown system replacement action.");
  return structuredClone(r);
}
export async function load(input) {
  let record;
  try {
    record = JSON.parse(await readFile(input.journalPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const request = replacementRequest(input);
  if (
    record.format !== format ||
    record.version !== 1 ||
    !isDeepStrictEqual(record.request, request) ||
    record.requestSha256 !== hash(request) ||
    !["running", "ready", "failed", "unknown"].includes(record.state) ||
    !record.steps ||
    typeof record.steps !== "object" ||
    (record.targetId !== null && !digest.test(record.targetId)) ||
    (record.state === "ready" &&
      (record.phase !== "complete" || !record.targetId || !record.prepared))
  )
    throw new Error(
      "The system replacement journal changed; retained state was preserved.",
    );
  return record;
}
export async function save(input, record, exclusive = false) {
  record.updatedAt = new Date().toISOString();
  await writeSystemJournal(input.journalPath, record, exclusive);
}
export function withReplacementLock(request, action, signal) {
  return withInstanceLock(
    request.container,
    () =>
      withInstanceLock(
        request.action === "replace"
          ? request.expectedContainerId
          : request.expectedOriginalId,
        action,
        { signal },
      ),
    { signal },
  );
}
export function checkContainer(actual, id) {
  if (
    !actual ||
    actual.Id !== id ||
    actual.Config?.Labels?.["io.cantrip.os"] !== "foundation" ||
    typeof actual.State?.Running !== "boolean" ||
    typeof actual.Name !== "string"
  )
    throw new Error(
      "The exact CantripOS container could not be verified; no replacement was selected.",
    );
  return actual;
}
export async function inspect(engine, id, signal) {
  return checkContainer(await engine.inspect(id, { signal }), id);
}
export function checkImage(actual, request) {
  const source = request.source;
  if (
    !actual ||
    actual.Id !== source.imageId ||
    actual.Os !== "linux" ||
    !Array.isArray(actual.RootFS?.Layers) ||
    actual.Config?.Labels?.["io.cantrip.os"] !== "foundation"
  )
    throw new Error("The exact foundation image could not be verified.");
  if (source.kind === "checkpoint") {
    const labels = actual.Config.Labels;
    if (
      labels["io.cantrip.os.system.operation"] !== source.operationId ||
      labels["io.cantrip.os.system.request"] !== source.requestSha256 ||
      labels["io.cantrip.os.system.container"] !== source.containerId ||
      labels["io.cantrip.os.system.instance"] !== request.instanceId
    )
      throw new Error(
        "The checkpoint image belongs to another original instance/admission.",
      );
  } else if (
    Object.keys(actual.Config.Labels).some(
      (key) =>
        key === sourceMountsLabel ||
        key.startsWith("io.cantrip.os.system.") ||
        key.startsWith(label("")),
    )
  ) {
    throw new Error(
      "A private system image cannot be used as a reusable base template.",
    );
  }
  return actual;
}
export function labels(record) {
  return {
    [label("operation")]: record.request.operationId,
    [label("request")]: record.requestSha256,
    [label("original")]: record.original.Id,
    [label("instance")]: record.request.instanceId,
    [label("configuration")]: record.configurationSha256,
  };
}
function mountIdentity(actual) {
  return (actual.Mounts ?? [])
    .filter((m) => m.Type === "bind" || m.Type === "volume")
    .map((m) => [
      m.Type,
      m.Type === "volume" ? m.Name : m.Source,
      m.Destination,
      !m.RW,
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
export function checkCandidate(actual, record, { activation = true } = {}) {
  checkContainer(actual, actual.Id);
  if (
    !digest.test(actual.Id) ||
    (record.targetId && actual.Id !== record.targetId) ||
    (!record.targetId && actual.Name !== `/${record.candidateName}`) ||
    actual.Image !== record.request.source.imageId ||
    Object.entries(labels(record)).some(
      ([k, v]) => actual.Config.Labels[k] !== v,
    ) ||
    (activation &&
      !isDeepStrictEqual(mountIdentity(actual), mountIdentity(record.original)))
  )
    throw new Error(
      "The candidate image, admission or retained mounts changed; it was not activated.",
    );
  return actual;
}
export async function candidate(engine, input, record, options) {
  if (record.targetId)
    return checkCandidate(
      await inspect(engine, record.targetId, input.signal),
      record,
      options,
    );
  const filters = encodeURIComponent(
    JSON.stringify({
      label: Object.entries(labels(record)).map(([k, v]) => `${k}=${v}`),
    }),
  );
  const values = await engine.request(
    "GET",
    `/containers/json?all=1&filters=${filters}`,
    undefined,
    { signal: input.signal },
  );
  if (!Array.isArray(values) || values.length > 1)
    throw new Error("Candidate creation has no unique original proof.");
  if (!values.length) return null;
  const actual = checkCandidate(
    await inspect(engine, values[0].Id, input.signal),
    record,
    options,
  );
  record.targetId = actual.Id;
  await save(input, record);
  return actual;
}
export function configuration(original, oldImage, targetImage, request) {
  const configured = imageDefaults(original, oldImage, targetImage);
  // The current mount layout is retained. Image defaults must not silently
  // introduce new anonymous data mounts during a root-only replacement.
  configured.Config.Volumes = structuredClone(original.Config.Volumes ?? {});
  const result = mountedConfiguration(
    configured,
    request.instanceId,
    sourceMounts(original, request.instanceId),
    { image: request.source.imageId },
  );
  const volumes = (original.Mounts ?? []).filter((m) => m.Type === "volume");
  result.HostConfig.Binds = (result.HostConfig.Binds ?? []).filter(
    (bind) => !volumes.some((m) => bind.startsWith(`${m.Name}:`)),
  );
  result.HostConfig.Mounts = (result.HostConfig.Mounts ?? []).filter(
    (m) => !volumes.some((v) => v.Destination === m.Target),
  );
  for (const actual of volumes) {
    const previous = original.HostConfig.Mounts?.find(
      (m) => m.Target === actual.Destination,
    );
    result.HostConfig.Mounts.push({
      ...previous,
      Type: "volume",
      Source: actual.Name,
      Target: actual.Destination,
      ReadOnly: !actual.RW,
      VolumeOptions: { ...previous?.VolumeOptions, NoCopy: true },
    });
  }
  result.HostConfig.RestartPolicy = { ...noRestart };
  for (const key of Object.keys(result.Labels))
    if (key.startsWith(label(""))) delete result.Labels[key];
  return result;
}
export function running(actual) {
  return actual.State.Running || actual.State.Restarting === true;
}
export function policy(actual) {
  return actual.HostConfig.RestartPolicy ?? noRestart;
}
export function policyEqual(actual, expected) {
  const value = policy(actual);
  return (
    value.Name === expected.Name &&
    (value.MaximumRetryCount ?? 0) === (expected.MaximumRetryCount ?? 0)
  );
}
const brief = (actual) => ({
  containerId: actual.Id,
  name: actual.Name,
  running: actual.State.Running,
  status: actual.State.Status ?? null,
  startedAt: actual.State.StartedAt ?? null,
  restartPolicy: policy(actual),
});
export async function result(engine, input, record) {
  let observation = null,
    observationError = null;
  try {
    observation = {
      retained: record.retireId
        ? brief(await inspect(engine, record.retireId, input.signal))
        : null,
      target: record.targetId
        ? brief(await inspect(engine, record.targetId, input.signal))
        : null,
    };
  } catch (error) {
    observationError = error.message;
  }
  return {
    operation: {
      format,
      version: 1,
      request: record.request,
      requestSha256: record.requestSha256,
      state: record.state,
      phase: record.phase,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      originalContainerId: record.original?.Id ?? null,
      retainedContainerId: record.retireId,
      targetContainerId: record.targetId,
      retainedName: record.retainedName,
      desiredRestartPolicy: record.desiredPolicy,
      runtimeHandlesRestored: false,
      error: record.error,
      lastError: record.lastError,
    },
    observation,
    observationError,
  };
}
export const missing = (error) =>
  error instanceof DockerApiError && error.status === 404;
