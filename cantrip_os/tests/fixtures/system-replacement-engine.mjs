import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerApiError, DockerDeliveryError } from "../../host/index.mjs";

export async function replacementFixture() {
  const directory = await mkdtemp(join(tmpdir(), "cantrip-system-replace-"));
  const oldId = "a".repeat(64),
    nextId = "b".repeat(64),
    oldImageId = `sha256:${"d".repeat(64)}`,
    nextImageId = `sha256:${"e".repeat(64)}`;
  const instanceId = randomUUID(),
    captureId = randomUUID(),
    name = `system-${randomUUID()}`;
  const oldConfig = {
    Labels: { "io.cantrip.os": "foundation" },
    Env: ["DEFAULT=old"],
    Cmd: ["sleep", "infinity"],
    Volumes: { "/data": {} },
  };
  const original = {
    Id: oldId,
    Name: `/${name}`,
    Image: oldImageId,
    Config: {
      ...structuredClone(oldConfig),
      Env: ["DEFAULT=old", "CUSTOM=retained"],
    },
    HostConfig: {
      RestartPolicy: { Name: "always", MaximumRetryCount: 0 },
      Memory: 4 * 1024 ** 3,
      Binds: ["retained:/data"],
      PortBindings: {
        "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: "16080" }],
      },
    },
    Mounts: [
      { Type: "volume", Name: "retained", Destination: "/data", RW: true },
    ],
    NetworkSettings: { Networks: { bridge: {} } },
    State: {
      Running: true,
      Restarting: false,
      StartedAt: new Date().toISOString(),
      Status: "running",
    },
  };
  const target = {
    Id: nextImageId,
    Os: "linux",
    Architecture: "amd64",
    RootFS: { Layers: [] },
    Config: {
      ...structuredClone(oldConfig),
      Env: ["DEFAULT=checkpoint"],
      Labels: {
        "io.cantrip.os": "foundation",
        "io.cantrip.os.system.operation": captureId,
        "io.cantrip.os.system.request": "c".repeat(64),
        "io.cantrip.os.system.container": oldId,
        "io.cantrip.os.system.instance": instanceId,
      },
    },
  };
  const images = new Map([
    [oldImageId, { Id: oldImageId, Config: oldConfig }],
    [nextImageId, target],
  ]);
  const containers = new Map([[oldId, original]]),
    effects = [],
    starts = new Map([[oldId, 1]]);
  let lose = null,
    refuse = null,
    before = null,
    unavailable = false,
    badMount = false;
  const get = (id) => {
    if (unavailable)
      throw new DockerDeliveryError("Actual Engine disconnected");
    const v =
      containers.get(id) ??
      [...containers.values()].find((c) => c.Name === `/${id}`);
    if (!v) throw new DockerApiError(404, "No such exact container");
    return v;
  };
  const engine = {
    inspect: async (id) => structuredClone(get(id)),
    request: async (method, path, body) => {
      if (unavailable)
        throw new DockerDeliveryError("Actual Engine disconnected");
      const url = new URL("http://engine" + path);
      if (method === "GET") {
        if (path.startsWith("/images/")) {
          const image = images.get(decodeURIComponent(path.split("/")[2]));
          if (!image) throw new DockerApiError(404, "No such image");
          return structuredClone(image);
        }
        if (path.startsWith("/containers/json?")) {
          const filter = JSON.parse(url.searchParams.get("filters"));
          return [...containers.values()]
            .filter((c) =>
              filter.label.every((entry) => {
                const at = entry.indexOf("=");
                return (
                  c.Config.Labels[entry.slice(0, at)] === entry.slice(at + 1)
                );
              }),
            )
            .map(({ Id }) => ({ Id }));
        }
        throw new Error("Unexpected GET " + path);
      }
      let action,
        value,
        receipt = null;
      if (path.startsWith("/containers/create?")) action = "create";
      else {
        value = get(path.split("/")[2]);
        action = path.endsWith("/update")
          ? body.RestartPolicy.Name === "no"
            ? "fence"
            : "policy"
          : path.includes("/stop?")
            ? "stop"
            : path.endsWith("/start")
              ? "start"
              : url.searchParams.get("name")?.includes("-previous-")
                ? "rename-retained"
                : "rename-target";
      }
      effects.push({ action, method, path, body: structuredClone(body) });
      if (refuse === action) {
        refuse = null;
        throw new DockerApiError(500, "Actual Engine refusal");
      }
      if (before === action) {
        before = null;
        throw new DockerDeliveryError("Delivery is still unknown");
      }
      if (action === "create") {
        const Config = structuredClone(body);
        delete Config.HostConfig;
        delete Config.NetworkingConfig;
        containers.set(nextId, {
          Id: nextId,
          Name: `/${url.searchParams.get("name")}`,
          Image: body.Image,
          Config,
          HostConfig: structuredClone(body.HostConfig),
          Mounts: structuredClone(original.Mounts),
          State: {
            Running: false,
            Restarting: false,
            Status: "created",
            StartedAt: "0001-01-01T00:00:00Z",
          },
        });
        if (badMount) containers.get(nextId).Mounts[0].Name = "wrong-volume";
        receipt = { Id: nextId };
      } else if (action === "fence" || action === "policy")
        value.HostConfig.RestartPolicy = structuredClone(body.RestartPolicy);
      else if (action === "stop") {
        value.State.Running = false;
        value.State.Status = "exited";
      } else if (action === "start") {
        value.State.Running = true;
        value.State.Status = "running";
        value.State.StartedAt = new Date().toISOString();
        starts.set(value.Id, (starts.get(value.Id) ?? 0) + 1);
      } else {
        const name = `/${url.searchParams.get("name")}`;
        if (
          [...containers.values()].some(
            (c) => c.Id !== value.Id && c.Name === name,
          )
        )
          throw new DockerApiError(409, "Name in use");
        value.Name = name;
      }
      if (lose === action) {
        lose = null;
        throw new DockerDeliveryError("Actual reply lost");
      }
      return receipt;
    },
    loadImage: async (source) => {
      effects.push({ action: "load" });
      for await (const _bytes of source) {
        /* Consume real staged bytes. */
      }
      images.set(nextImageId, structuredClone(target));
      return [];
    },
  };
  const input = {
    journalPath: join(directory, "replace.json"),
    request: {
      action: "replace",
      operationId: randomUUID(),
      container: name,
      expectedContainerId: oldId,
      instanceId,
      scopeKey: "f".repeat(64),
      startTarget: true,
      source: {
        kind: "checkpoint",
        imageId: nextImageId,
        operationId: captureId,
        requestSha256: "c".repeat(64),
        containerId: oldId,
      },
      archive: null,
    },
  };
  return {
    directory,
    engine,
    input,
    original,
    target,
    images,
    containers,
    effects,
    starts,
    oldId,
    nextId,
    lose: (action) => {
      lose = action;
    },
    refuse: (action) => {
      refuse = action;
    },
    before: (action) => {
      before = action;
    },
    unavailable: () => {
      unavailable = true;
    },
    badMount: () => {
      badMount = true;
    },
  };
}
