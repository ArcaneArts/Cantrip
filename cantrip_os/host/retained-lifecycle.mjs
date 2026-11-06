import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { dirname } from "node:path";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { DockerApiError, DockerDeliveryError } from "./docker.mjs";
import { withInstanceLock } from "./lock.mjs";

async function writeJournal(file, value, exclusive = false) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.partial`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(value) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (exclusive) {
      await link(temporary, file);
      await unlink(temporary);
    } else await rename(temporary, file);
    const directory = await open(dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function admission(input) {
  if (!["start", "stop", "restart"].includes(input.action))
    throw new Error("Choose a retained-container start, stop or restart.");
  return {
    operationId: input.operationId,
    action: input.action,
    container: input.container,
    expectedContainerId: input.expectedContainerId,
  };
}

async function load(input) {
  try {
    const record = JSON.parse(await readFile(input.journalPath, "utf8"));
    if (
      record.version !== 1 ||
      !isDeepStrictEqual(record.request, admission(input))
    )
      throw new Error(
        "This lifecycle operation already belongs to another target or action.",
      );
    if (
      !["running", "ready", "failed", "unknown"].includes(record.state) ||
      ![
        "reserved",
        "mutation-requested",
        "mutation-acknowledged",
        "verified",
      ].includes(record.phase) ||
      (record.state === "ready" &&
        (record.phase !== "verified" ||
          !record.after ||
          record.after.containerId !== input.expectedContainerId ||
          !["acknowledged-and-observed", "observed-state"].includes(
            record.completionEvidence,
          ) ||
          !desired(record, record.after)))
    )
      throw new Error(
        "The saved lifecycle record has no matching transition evidence.",
      );
    return record;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function inspect(engine, reference, expectedContainerId, signal) {
  const actual = await engine.inspect(reference, { signal });
  if (actual.Id !== expectedContainerId)
    throw new Error(
      "The retained Docker container changed; no replacement was selected.",
    );
  if (typeof actual.State?.Running !== "boolean")
    throw new Error("Docker returned no actual container running state.");
  return {
    containerId: actual.Id,
    name: actual.Name,
    running: actual.State.Running,
    status: actual.State.Status,
    startedAt: actual.State.StartedAt,
    finishedAt: actual.State.FinishedAt,
  };
}

function desired(record, observation) {
  if (!record.before) return false;
  if (record.request.action === "stop") return !observation.running;
  if (!observation.running) return false;
  return (
    record.request.action !== "restart" ||
    observation.startedAt !== record.before.startedAt
  );
}

async function observe(engine, input, record) {
  let observation = null,
    observationError = null;
  try {
    observation = await inspect(
      engine,
      record.request.expectedContainerId,
      record.request.expectedContainerId,
      input.signal,
    );
  } catch (error) {
    observationError = error.message;
  }
  // Historical outcomes do not change when someone subsequently stops/removes
  // the container. Current carrier availability is reported separately.
  if (record.state === "ready" || record.state === "failed")
    return { operation: record, observation, observationError };
  if (
    observation &&
    record.phase !== "reserved" &&
    desired(record, observation)
  ) {
    record.state = "ready";
    record.phase = "verified";
    record.after = observation;
    record.completionEvidence = "observed-state";
    record.error = null;
  } else {
    record.state = "unknown";
    record.error =
      observationError ??
      (record.phase === "reserved"
        ? "No Docker mutation was dispatched by this admission. A repeated request only observes it."
        : "The admitted Docker transition is not verified. No mutation was replayed.");
  }
  record.updatedAt = new Date().toISOString();
  await writeJournal(input.journalPath, record);
  return { operation: record, observation, observationError };
}

/** Inspect the exact saved operation and immutable Docker ID. Never creates an
 * admission or repeats a mutation, even after a process dies before dispatch. */
export async function observeRetainedContainer(engine, input) {
  return withInstanceLock(
    input.container,
    async () => {
      const record = await load(input);
      return record ? observe(engine, input, record) : null;
    },
    { signal: input.signal },
  );
}

/** The caller supplies an already authorized immutable Docker ID. Names are
 * resolved once before mutation; POST always addresses that exact retained ID.
 * No create/remove/image/volume operation is performed here. */
export async function changeRetainedContainer(engine, input) {
  return withInstanceLock(
    input.container,
    async () => {
      const previous = await load(input);
      if (previous) return observe(engine, input, previous);
      const record = {
        version: 1,
        request: admission(input),
        state: "running",
        phase: "reserved",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        before: null,
        after: null,
        completionEvidence: null,
        error: null,
      };
      await writeJournal(input.journalPath, record, true);
      const save = async () => {
        record.updatedAt = new Date().toISOString();
        await writeJournal(input.journalPath, record);
      };
      try {
        record.before = await inspect(
          engine,
          input.container,
          input.expectedContainerId,
          input.signal,
        );
        record.phase = "mutation-requested";
        await save();
        const suffix = input.action === "start" ? "" : "?t=20";
        await engine.request(
          "POST",
          `/containers/${encodeURIComponent(input.expectedContainerId)}/${input.action}${suffix}`,
          undefined,
          { signal: input.signal, timeout: 90_000 },
        );
        record.phase = "mutation-acknowledged";
        await save();
        record.after = await inspect(
          engine,
          input.expectedContainerId,
          input.expectedContainerId,
          input.signal,
        );
        if (!desired(record, record.after))
          throw new DockerDeliveryError(
            "Docker acknowledged the request but its intended state is not verified.",
          );
        record.state = "ready";
        record.phase = "verified";
        record.completionEvidence = "acknowledged-and-observed";
      } catch (error) {
        record.state =
          record.phase === "reserved" || error instanceof DockerApiError
            ? "failed"
            : "unknown";
        record.error = error.message;
      }
      try {
        await save();
      } catch (cause) {
        throw new DockerDeliveryError(
          "The lifecycle outcome could not be recorded. Observe this operation before retrying.",
          { cause },
        );
      }
      return {
        operation: record,
        observation: record.after,
        observationError: null,
      };
    },
    { signal: input.signal },
  );
}
