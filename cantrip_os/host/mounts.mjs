import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { withInstanceLock } from "./lock.mjs";
import { DockerApiError } from "./docker.mjs";
import { imageDefaults, sourceMountsLabel } from "./image-defaults.mjs";

export { sourceMountsLabel };
const volumeName = (instance, binding, path) =>
  "cantrip-os-deps-" +
  createHash("sha256")
    .update(JSON.stringify([instance, binding, path]))
    .digest("hex")
    .slice(0, 40);

export function sourceMounts(record, expectedInstanceId) {
  const raw = record.Config.Labels?.[sourceMountsLabel];
  if (!raw) return [];
  const state = JSON.parse(raw);
  if (state.version !== 1 || !Array.isArray(state.bindings))
    throw new Error(
      "Unsupported CantripOS source mount state; the container was preserved.",
    );
  if (
    expectedInstanceId !== undefined &&
    state.instanceId !== expectedInstanceId
  )
    throw new Error(
      "The recorded source mounts belong to a different OS instance.",
    );
  return state.bindings;
}

function mounts(instanceId, bindings) {
  return bindings.flatMap((binding) => {
    if (
      !/^[a-f0-9-]{36}$/i.test(binding.id) ||
      binding.guestPath !== `/workspace/${binding.id}` ||
      !binding.workerPath ||
      binding.workerPath.includes("\0")
    )
      throw new Error(
        "A linked binding requires its exact worker path and stable guest root.",
      );
    const paths = binding.dependencyOverlays.map(({ path }) => {
      if (
        path
          .split("/")
          .some((part) => !part || part === "." || part === "..") ||
        path.includes("\0") ||
        path.split("/")[0] === ".git"
      )
        throw new Error("Invalid explicit dependency overlay path.");
      return path;
    });
    if (new Set(paths).size !== paths.length)
      throw new Error("Duplicate dependency overlay.");
    return [
      {
        Type: "bind",
        Source: binding.workerPath,
        Target: binding.guestPath,
        BindOptions: { Propagation: "rprivate" },
      },
      ...paths.map((path) => ({
        Type: "volume",
        Source: volumeName(instanceId, binding.cacheKey ?? binding.id, path),
        Target: posix.join(binding.guestPath, path),
        VolumeOptions: { NoCopy: true },
      })),
    ];
  });
}

/** Reuses the declared container configuration instead of reconstructing a
 * partial docker run command. Named/bind volumes and Linux caches are retained. */
export function mountedConfiguration(
  record,
  instanceId,
  bindings,
  { image } = {},
) {
  if (record.Config.Labels?.["io.cantrip.os"] !== "foundation")
    throw new Error("Source mounts require a CantripOS foundation container.");
  if (new Set(bindings.map((binding) => binding.id)).size !== bindings.length)
    throw new Error("Duplicate source binding.");
  const previousTargets = new Set(
    mounts(instanceId, sourceMounts(record, instanceId)).map(
      (mount) => mount.Target,
    ),
  );
  const host = structuredClone(record.HostConfig);
  host.Mounts = [
    ...(host.Mounts ?? []).filter(
      (mount) => !previousTargets.has(mount.Target),
    ),
    ...mounts(instanceId, bindings),
  ];
  // Image-declared anonymous data volumes are not present in HostConfig.Binds.
  // Retain their actual names too, rather than silently replacing their data.
  for (const actual of record.Mounts ?? []) {
    if (
      actual.Type !== "volume" ||
      previousTargets.has(actual.Destination) ||
      host.Mounts.some((mount) => mount.Target === actual.Destination) ||
      (host.Binds ?? []).some((bind) => bind.startsWith(`${actual.Name}:`))
    )
      continue;
    host.Mounts.push({
      Type: "volume",
      Source: actual.Name,
      Target: actual.Destination,
      ReadOnly: !actual.RW,
      VolumeOptions: { NoCopy: true },
    });
  }
  const endpoints = Object.fromEntries(
    Object.entries(record.NetworkSettings.Networks ?? {}).map(
      ([name, network]) => [
        name,
        {
          ...(network.IPAMConfig ? { IPAMConfig: network.IPAMConfig } : {}),
          ...(network.Links ? { Links: network.Links } : {}),
          ...(network.Aliases
            ? {
                Aliases: network.Aliases.filter(
                  (alias) =>
                    alias !== record.Id && alias !== record.Id.slice(0, 12),
                ),
              }
            : {}),
        },
      ],
    ),
  );
  return {
    ...structuredClone(record.Config),
    Image: image ?? record.Image,
    Labels: {
      ...record.Config.Labels,
      [sourceMountsLabel]: JSON.stringify({ version: 1, instanceId, bindings }),
    },
    HostConfig: host,
    NetworkingConfig: { EndpointsConfig: endpoints },
  };
}

async function journal(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(state) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}

/** Explicitly interrupts the entire OS. Each mutation runs once. A journal and
 * stable candidate/previous names permit observation after uncertain delivery;
 * a caller must reconcile these identities rather than replay this operation. */
export async function recreateWithSources(engine, input) {
  return withInstanceLock(input.container, () => recreate(engine, input), {
    signal: input.signal,
  });
}

async function recreate(
  engine,
  {
    container,
    expectedContainerId,
    instanceId,
    bindings,
    operationId,
    journalPath,
    image,
    preserveSystem = image === undefined,
    signal,
  },
) {
  const original = await engine.inspect(container, { signal });
  const request = (method, path, body, options = {}) =>
    engine.request(method, path, body, { ...options, signal });
  if (original.Id !== expectedContainerId)
    throw new Error("The CantripOS container changed before recreation.");
  let configured = original;
  if (image !== undefined) {
    const [oldImage, newImage] = await Promise.all([
      request("GET", `/images/${encodeURIComponent(original.Image)}/json`),
      request("GET", `/images/${encodeURIComponent(image)}/json`),
    ]);
    configured = imageDefaults(original, oldImage, newImage);
  }
  const configuration = mountedConfiguration(configured, instanceId, bindings, {
    image,
  });
  const suffix = createHash("sha256")
    .update(operationId)
    .digest("hex")
    .slice(0, 16);
  const candidate = `${container}-next-${suffix}`,
    previous = `${container}-previous-${suffix}`;
  const state = {
    version: 1,
    operationId,
    container,
    instanceId,
    original,
    candidate,
    previous,
    bindings,
    phase: "planned",
  };
  await mkdir(dirname(journalPath), { recursive: true, mode: 0o700 });
  // Unknown delivery is reconciled through this exclusive reservation, not a
  // second snapshot/create attempt with the same operation identity.
  await writeFile(journalPath, JSON.stringify(state) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  async function step(phase, execute) {
    signal?.throwIfAborted();
    state.phase = `${phase}-requested`;
    await journal(journalPath, state);
    const receipt = await execute();
    state.phase = `${phase}-completed`;
    await journal(journalPath, state);
    return receipt;
  }
  if (preserveSystem) {
    // Source mount changes retain root-installed software/configuration too.
    // Docker commit excludes mounted project/home/cache volumes. A deliberate
    // image rebuild supplies its new image instead of snapshotting old defaults.
    const snapshot = await step("snapshot-system", () =>
      request(
        "POST",
        `/commit?container=${original.Id}&pause=true`,
        undefined,
        { timeout: 300_000 },
      ),
    );
    configuration.Image = snapshot.Id;
    state.snapshotImage = snapshot.Id;
  }
  const created = await step("create", () =>
    request(
      "POST",
      `/containers/create?name=${encodeURIComponent(candidate)}`,
      configuration,
    ),
  );
  state.candidateId = created.Id;
  await step("stop-original", () =>
    request("POST", `/containers/${original.Id}/stop?t=20`, undefined),
  );
  await step("rename-original", () =>
    request(
      "POST",
      `/containers/${original.Id}/rename?name=${encodeURIComponent(previous)}`,
      undefined,
    ),
  );
  await step("rename-candidate", () =>
    request(
      "POST",
      `/containers/${created.Id}/rename?name=${encodeURIComponent(container)}`,
      undefined,
    ),
  );
  await step("start", () =>
    request("POST", `/containers/${created.Id}/start`, undefined),
  );
  // The stopped previous container remains until the worker verifies the actual
  // mounted bytes/executor identity. Its root layer is available for recovery.
  return {
    containerId: created.Id,
    previousContainerId: original.Id,
    journalPath,
  };
}

export function dependencyVolumes(instanceId, bindings) {
  return mounts(instanceId, bindings)
    .filter((mount) => mount.Type === "volume")
    .map((mount) => ({ name: mount.Source, guestPath: mount.Target }));
}

export async function finalizeRecreation(engine, journalPath, { signal } = {}) {
  const saved = JSON.parse(await readFile(journalPath, "utf8"));
  return withInstanceLock(
    saved.container,
    async () => {
      const state = JSON.parse(await readFile(journalPath, "utf8"));
      if (state.phase === "complete") return;
      if (
        state.version !== 1 ||
        !["start-completed", "remove-original-requested"].includes(state.phase)
      )
        throw new Error(
          "Reconcile the incomplete OS replacement before removing its previous container.",
        );
      const current = await engine.inspect(state.container, { signal });
      if (current.Id !== state.candidateId)
        throw new Error(
          "The replacement OS changed before cleanup; its previous container was preserved.",
        );
      state.phase = "remove-original-requested";
      await journal(journalPath, state);
      try {
        // No force and no volume deletion. Docker refuses a running recovery
        // container; already-removed IDs are a successful cleanup outcome.
        await engine.request(
          "DELETE",
          `/containers/${state.original.Id}?v=false`,
          undefined,
          { signal },
        );
      } catch (error) {
        if (!(error instanceof DockerApiError) || error.status !== 404)
          throw error;
      }
      state.phase = "complete";
      await journal(journalPath, state);
    },
    { signal },
  );
}
