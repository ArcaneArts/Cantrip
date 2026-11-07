import { randomBytes, randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { LocalDocker } from "@cantrip/os-host";
import { DockerApiError, DockerDeliveryError } from "@cantrip/os-host";
import type { CantripOsSystemScope } from "@cantrip/protocol";
import type { BackupKeyAccess } from "./private-backup-file.js";

export function tarFile(bytes: Uint8Array, { kind = "0", link = "" } = {}) {
  const header = Buffer.alloc(512),
    content = Buffer.from(bytes);
  header.write("instance.json");
  header.write("0000600\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(content.length.toString(8).padStart(11, "0") + "\0", 124);
  header.fill(32, 148, 156);
  header.write(kind, 156);
  header.write(link, 157, 100, "utf8");
  header.write("ustar\0", 257);
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([
    header,
    content,
    Buffer.alloc((512 - (content.length % 512)) % 512),
    Buffer.alloc(1024),
  ]);
}
type Container = {
  Id: string;
  Name: string;
  Image: string;
  Config: Record<string, any>;
  HostConfig: Record<string, any>;
  Mounts: Array<Record<string, any>>;
  NetworkSettings: { Networks: object };
  State: { Running: boolean; StartedAt: string; Status: string };
  files: Map<string, Buffer>;
};
type Image = {
  Id: string;
  Config: Record<string, any>;
  files: Map<string, Buffer>;
  Architecture: string;
  Os: string;
  RootFS: { Layers: string[] };
  Created: string;
  Size: number;
  RepoTags: string[];
};
export function systemFixture() {
  const scope: CantripOsSystemScope = {
    ownerId: "fixture-owner",
    serverId: "fixture-server",
    workerId: "fixture-worker",
    instanceId: randomUUID(),
    guestInstanceId: randomUUID(),
    attachmentGeneration: randomUUID(),
  };
  const rootId = "a".repeat(64),
    baseId = `sha256:${"b".repeat(64)}`,
    name = `system-${randomUUID()}`;
  const identityPath = "/var/lib/cantrip-os-executor/instance.json";
  const identity = {
    version: 1,
    instance_id: scope.guestInstanceId,
    attachment: { owner_id: scope.ownerId, worker_id: scope.workerId },
  };
  const files = new Map([
    [
      "/etc/cantrip-os/executor.json",
      Buffer.from(
        JSON.stringify({ state_dir: "/var/lib/cantrip-os-executor" }),
      ),
    ],
    [identityPath, Buffer.from(JSON.stringify(identity))],
  ]);
  const config = {
    Labels: { "io.cantrip.os": "foundation" },
    Env: ["DEFAULT=retained"],
    Cmd: ["sleep", "infinity"],
  };
  const base: Image = {
    Id: baseId,
    Config: structuredClone(config),
    files: new Map(),
    Architecture: "amd64",
    Os: "linux",
    RootFS: { Layers: [] },
    Created: new Date().toISOString(),
    Size: 4096,
    RepoTags: ["cantrip-os:fixture"],
  };
  const root: Container = {
    Id: rootId,
    Name: `/${name}`,
    Image: baseId,
    Config: structuredClone(config),
    HostConfig: {
      RestartPolicy: { Name: "always", MaximumRetryCount: 0 },
      Mounts: [],
    },
    Mounts: [],
    NetworkSettings: { Networks: {} },
    State: {
      Running: true,
      StartedAt: new Date().toISOString(),
      Status: "running",
    },
    files,
  };
  const containers = new Map([[rootId, root]]),
    images = new Map([[baseId, base]]),
    effects: Array<{ action: string; path: string }> = [];
  let sequence = 1,
    lose: string | null = null,
    locked = false,
    owner = scope.ownerId;
  const key = randomBytes(32),
    keys: BackupKeyAccess = {
      ownerId: () => owner,
      serverIdentity: () => scope.serverId,
      componentKey: (_component, revision = 1) => {
        if (locked || revision !== 1)
          throw new Error("No active fixture grant");
        return { key: new Uint8Array(key), keyRevision: 1 };
      },
    };
  const get = (id: string) => {
    const value =
      containers.get(id) ??
      [...containers.values()].find((c) => c.Name === `/${id}`);
    if (!value) throw new DockerApiError(404, "No such fixture container");
    return value;
  };
  const engine = {
    inspect: async (id: string) => structuredClone(get(id)),
    request: async (method: string, path: string, body?: any) => {
      const url = new URL("http://fixture" + path);
      if (method === "GET") {
        if (path.startsWith("/images/json"))
          return [...images.values()].map((i) => ({
            Id: i.Id,
            Labels: i.Config.Labels,
            RepoTags: i.RepoTags,
          }));
        if (path.startsWith("/images/")) {
          const image = images.get(decodeURIComponent(path.split("/")[2]!));
          if (!image) throw new DockerApiError(404, "No such fixture image");
          return structuredClone(image);
        }
        if (path.startsWith("/containers/json")) {
          const filters = JSON.parse(url.searchParams.get("filters")!);
          return [...containers.values()]
            .filter((c) =>
              filters.label.every((label: string) => {
                const at = label.indexOf("=");
                return (
                  c.Config.Labels[label.slice(0, at)] === label.slice(at + 1)
                );
              }),
            )
            .map(({ Id }) => ({ Id }));
        }
        throw new Error("Unexpected fixture GET");
      }
      let action, value: unknown;
      if (path.startsWith("/commit?")) {
        action = "commit";
        const source = get(url.searchParams.get("container")!);
        const Id = `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
        images.set(Id, {
          ...structuredClone(base),
          Id,
          Config: structuredClone(body),
          files: structuredClone(source.files),
        });
        value = { Id };
      } else if (path.startsWith("/containers/create?")) {
        action = "create";
        const image = images.get(body.Image)!;
        const Id = (++sequence).toString(16).padStart(64, "0"),
          Config = structuredClone(body);
        delete Config.HostConfig;
        delete Config.NetworkingConfig;
        containers.set(Id, {
          ...structuredClone(root),
          Id,
          Name: `/${url.searchParams.get("name")}`,
          Image: image.Id,
          Config,
          HostConfig: structuredClone(body.HostConfig),
          files: structuredClone(image.files),
          State: {
            Running: false,
            StartedAt: "0001-01-01T00:00:00Z",
            Status: "created",
          },
        });
        value = { Id };
      } else {
        const current = get(path.split("/")[2]!);
        if (path.includes("/stop?")) {
          action = "stop";
          current.State.Running = false;
          current.State.Status = "exited";
        } else if (path.endsWith("/start")) {
          action = "start";
          current.State.Running = true;
          current.State.StartedAt = new Date().toISOString();
          current.State.Status = "running";
        } else if (path.endsWith("/update")) {
          action = "policy";
          current.HostConfig.RestartPolicy = structuredClone(
            body.RestartPolicy,
          );
        } else if (path.includes("/rename?")) {
          action = "rename";
          const selected = `/${url.searchParams.get("name")}`;
          if (
            [...containers.values()].some(
              (c) => c.Id !== current.Id && c.Name === selected,
            )
          )
            throw new DockerApiError(409, "Name in use");
          current.Name = selected;
        } else throw new Error("Unexpected fixture mutation");
        value = null;
      }
      effects.push({ action, path });
      if (lose === action) {
        lose = null;
        throw new DockerDeliveryError("/private/actual-reply-lost");
      }
      return value;
    },
    readStream: async (path: string) => {
      if (path.startsWith("/images/"))
        return Readable.from([Buffer.from("PRIVATE_ROOT_TAR_FIXTURE_BYTES")]);
      const url = new URL("http://fixture" + path),
        current = get(path.split("/")[2]!),
        body = current.files.get(url.searchParams.get("path")!);
      if (!body)
        throw new DockerApiError(404, "No such guest configuration file");
      return Readable.from([tarFile(body)]);
    },
    loadImage: async (stream: Readable) => {
      effects.push({ action: "load", path: "/images/load" });
      for await (const _ of stream) {
        /* Fixture tar. */
      }
      return [];
    },
  } as unknown as LocalDocker;
  return {
    scope,
    root,
    rootId,
    baseId,
    name,
    engine,
    keys,
    key,
    files,
    identityPath,
    identity,
    effects,
    containers,
    images,
    lose: (action: string) => {
      lose = action;
    },
    lock: () => {
      locked = true;
    },
    unlock: () => {
      locked = false;
    },
    changeOwner: () => {
      owner = "another-owner";
    },
  };
}
