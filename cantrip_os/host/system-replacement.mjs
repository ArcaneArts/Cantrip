import { readFile } from "node:fs/promises";
import { withInstanceLock } from "./lock.mjs";
import { DockerApiError } from "./docker.mjs";
import { ensureImage } from "./system-image-load.mjs";
import {
  format,
  noRestart,
  hash,
  label,
  replacementRequest,
  load,
  save,
  withReplacementLock,
  inspect,
  labels,
  candidate,
  configuration,
  running,
  policy,
  policyEqual,
  result,
} from "./system-replacement-state.mjs";

function names(request) {
  const prefix = request.container.slice(0, 80),
    suffix = hash(request.operationId).slice(0, 24);
  return {
    candidateName: `${prefix}-next-${suffix}`,
    retainedName: `${prefix}-previous-${suffix}`,
  };
}
async function prepare(engine, input, record, mutate) {
  const r = record.request;
  if (r.action === "replace") {
    if (!record.original) {
      const original = await inspect(
        engine,
        r.expectedContainerId,
        input.signal,
      );
      const selected = await engine.inspect(r.container, {
        signal: input.signal,
      });
      if (selected.Id !== original.Id || original.Name !== `/${r.container}`)
        throw new Error(
          "Replacement requires the original canonical Docker name and exact ID.",
        );
      record.original = original;
      record.retireId = original.Id;
      record.desiredPolicy = policy(original);
      await save(input, record);
    }
    if (record.prepared) return true;
    const image = await ensureImage(engine, input, record, mutate);
    if (!image) return false;
    const oldImage = await engine.request(
      "GET",
      `/images/${encodeURIComponent(record.original.Image)}/json`,
      undefined,
      { signal: input.signal },
    );
    record.configuration = configuration(record.original, oldImage, image, r);
    record.configurationSha256 = hash(record.configuration);
    Object.assign(record.configuration.Labels, labels(record));
    record.prepared = true;
    record.phase = "prepared";
    await save(input, record);
    return true;
  }
  if (record.prepared) return true;
  if (!input.replacementJournalPath)
    throw new Error(
      "The retained replacement journal is required for rollback.",
    );
  const raw = JSON.parse(await readFile(input.replacementJournalPath, "utf8"));
  const sourceInput = {
    journalPath: input.replacementJournalPath,
    request: raw.request,
    signal: input.signal,
  };
  const source = await load(sourceInput);
  if (
    !source ||
    source.request.action !== "replace" ||
    source.request.operationId !== r.replacementOperationId ||
    source.requestSha256 !== r.replacementRequestSha256 ||
    source.request.instanceId !== r.instanceId ||
    source.request.container !== r.container ||
    source.original?.Id !== r.expectedOriginalId
  )
    throw new Error(
      "Rollback belongs to another original replacement admission.",
    );
  const target = await inspect(engine, source.original.Id, input.signal);
  // Incorrect mounts forbid activation, but do not prevent fencing/stopping the
  // same proven candidate while recovering the retained original.
  const replacement = source.configuration
    ? await candidate(engine, sourceInput, source, { activation: false })
    : null;
  const start = source.steps.start;
  if (
    start?.claimed &&
    !start.acknowledged &&
    !start.observed &&
    !start.refused &&
    (!replacement?.State.StartedAt ||
      replacement.State.StartedAt.startsWith("0001-"))
  )
    throw new Error(
      "The original start is still uncertain; rollback did not admit both identities.",
    );
  if (
    target.Name !== `/${r.container}` &&
    target.Name !== `/${source.retainedName}`
  )
    throw new Error(
      "The retained original name changed outside its replacement.",
    );
  record.original = source.original;
  record.targetId = target.Id;
  record.retireId = replacement?.Id ?? null;
  record.desiredPolicy = policy(source.original);
  record.sourceRequestSha256 = source.requestSha256;
  record.prepared = true;
  record.phase = "prepared";
  await save(input, record);
  return true;
}

/** Every effect has a durable claim. Proof may observe completion, but a claimed
 * effect is never dispatched again, even under explicit continuation. */
async function advance(engine, input, record, mutate) {
  if (!(await prepare(engine, input, record, mutate))) return;
  const signal = input.signal,
    r = record.request;
  const current = (id) => inspect(engine, id, signal);
  const request = (method, path, body) =>
    engine.request(method, path, body, { signal });
  const step = async (key, proof, effect) => {
    signal?.throwIfAborted();
    if (await proof()) {
      record.steps[key] = { ...record.steps[key], observed: true };
      record.phase = `${key}-verified`;
      await save(input, record);
      return true;
    }
    if (!mutate || record.steps[key]?.claimed) return false;
    record.steps[key] = { claimed: true, acknowledged: false };
    record.phase = `${key}-requested`;
    await save(input, record);
    try {
      await effect();
      record.steps[key].acknowledged = true;
      await save(input, record);
    } catch (error) {
      if (error instanceof DockerApiError) {
        record.steps[key].acknowledged = true;
        record.steps[key].refused = true;
        error.definitive = true;
      }
      throw error;
    }
    if (!(await proof())) return false;
    record.steps[key].observed = true;
    record.phase = `${key}-verified`;
    await save(input, record);
    return true;
  };
  if (record.retireId) {
    if (
      !(await step(
        "fence",
        async () => policyEqual(await current(record.retireId), noRestart),
        () =>
          request("POST", `/containers/${record.retireId}/update`, {
            RestartPolicy: noRestart,
          }),
      ))
    )
      return;
    if (
      !(await step(
        "stop",
        async () => !running(await current(record.retireId)),
        () => request("POST", `/containers/${record.retireId}/stop?t=20`),
      ))
    )
      return;
  }
  if (
    r.action === "replace" &&
    !(await step(
      "create",
      async () => Boolean(await candidate(engine, input, record)),
      async () => {
        const created = await request(
          "POST",
          `/containers/create?name=${encodeURIComponent(record.candidateName)}`,
          record.configuration,
        );
        if (!/^[a-f0-9]{64}$/.test(created?.Id))
          throw new Error(
            "Docker did not return the exact candidate identity.",
          );
        record.targetId = created.Id;
      },
    ))
  )
    return;
  if (r.action === "replace") await candidate(engine, input, record);
  if (record.retireId) {
    if (
      running(await current(record.retireId)) ||
      !policyEqual(await current(record.retireId), noRestart)
    )
      throw new Error(
        "The retired identity is no longer fenced; the replacement was not started.",
      );
    if (
      !(await step(
        "rename-retained",
        async () =>
          (await current(record.retireId)).Name === `/${record.retainedName}`,
        () =>
          request(
            "POST",
            `/containers/${record.retireId}/rename?name=${encodeURIComponent(record.retainedName)}`,
          ),
      ))
    )
      return;
  }
  if (
    !(await step(
      "rename-target",
      async () => (await current(record.targetId)).Name === `/${r.container}`,
      () =>
        request(
          "POST",
          `/containers/${record.targetId}/rename?name=${encodeURIComponent(r.container)}`,
        ),
    ))
  )
    return;
  if (
    r.startTarget &&
    !(await step(
      "start",
      async () => {
        const value = await current(record.targetId);
        if (
          !running(value) &&
          record.steps.start?.acknowledged &&
          value.State.StartedAt &&
          !value.State.StartedAt.startsWith("0001-")
        )
          throw Object.assign(
            new Error(
              "The target exited after start; its retained original remains available for rollback.",
            ),
            { definitive: true },
          );
        return value.State.Running;
      },
      () => request("POST", `/containers/${record.targetId}/start`),
    ))
  )
    return;
  if (
    !(await step(
      "policy",
      async () =>
        policyEqual(await current(record.targetId), record.desiredPolicy),
      () =>
        request("POST", `/containers/${record.targetId}/update`, {
          RestartPolicy: record.desiredPolicy,
        }),
    ))
  )
    return;
  if (
    record.retireId &&
    (running(await current(record.retireId)) ||
      !policyEqual(await current(record.retireId), noRestart))
  )
    throw new Error(
      "Both identities could run; no fresh execution authority was issued.",
    );
  if ((await current(record.targetId)).Name !== `/${r.container}`)
    throw new Error("The active canonical Docker name changed.");
  record.state = "ready";
  record.phase = "complete";
  record.error = null;
  await save(input, record);
}

async function run(engine, input, mode) {
  const request = replacementRequest(input);
  return withReplacementLock(
    request,
    async () => {
      let record = await load(input),
        fresh = !record;
      if (!record) {
        if (mode === "observe") return null;
        if (mode === "continue")
          throw new Error(
            "There is no original system replacement admission to continue.",
          );
        const at = new Date().toISOString();
        record = {
          format,
          version: 1,
          request,
          requestSha256: hash(request),
          state: "running",
          phase: "reserved",
          startedAt: at,
          updatedAt: at,
          original: null,
          retireId: null,
          targetId: null,
          configuration: null,
          configurationSha256: null,
          desiredPolicy: null,
          prepared: false,
          steps: {},
          error: null,
          lastError: null,
          ...names(request),
        };
        await save(input, record, true);
      }
      if (record.state === "ready" || record.state === "failed")
        return result(engine, input, record);
      const mutate = fresh || mode === "continue";
      try {
        const prepared = await prepare(engine, input, record, mutate);
        // The same canonical lock covers preparation and all transitions. Once
        // known, the candidate's physical lock also coordinates alias-based capture.
        if (
          prepared &&
          record.retireId &&
          record.retireId !==
            (request.expectedContainerId ?? request.expectedOriginalId)
        )
          await withInstanceLock(
            record.retireId,
            () => advance(engine, input, record, mutate),
            { signal: input.signal },
          );
        else if (prepared) await advance(engine, input, record, mutate);
        if (record.state !== "ready") {
          record.state = "unknown";
          record.error =
            "The original transition is incomplete or uncertain; observe it or explicitly continue unrequested steps.";
          await save(input, record);
        }
      } catch (error) {
        record.state = error.definitive ? "failed" : "unknown";
        record.error = error.message;
        record.lastError = error.message;
        await save(input, record);
      }
      return result(engine, input, record);
    },
    input.signal,
  );
}
export const replaceSystem = (engine, input) => run(engine, input, "execute");
export const observeSystemReplacement = (engine, input) =>
  run(engine, input, "observe");
export const continueSystemReplacement = (engine, input) =>
  run(engine, input, "continue");
