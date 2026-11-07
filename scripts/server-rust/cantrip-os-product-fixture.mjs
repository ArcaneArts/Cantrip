// Disposable real Docker guest. Production guest packages and worker handlers
// remain unchanged; all names and volumes belong to this one acceptance cell.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { promisify } from "node:util";

const execute = promisify(execFile);
export class CantripOsProductFixture {
  constructor(directory) {
    this.directory = directory;
    this.name = `cantrip-rust-os-${randomUUID()}`;
    this.volumes = ["home", "workspaces", "executor"].map(
      (suffix) => `${this.name}-${suffix}`,
    );
    this.commands = [];
    this.ownedContainers = new Set();
    this.privateImages = new Set();
  }
  async docker(...args) {
    const entry = { args, startedAt: new Date().toISOString() };
    this.commands.push(entry);
    try {
      const value = await execute("docker", args, {
        maxBuffer: 16 * 1024 * 1024,
      });
      entry.stdout = value.stdout;
      entry.stderr = value.stderr;
      entry.exitCode = 0;
      return value.stdout.trim();
    } catch (error) {
      entry.failure = error.message;
      entry.exitCode = error.code;
      throw error;
    } finally {
      entry.endedAt = new Date().toISOString();
    }
  }
  async json(...args) {
    return JSON.parse(await this.docker(...args));
  }
  async start() {
    await mkdir(this.directory, { recursive: true });
    const image = process.env.CANTRIP_TEST_OS_IMAGE ?? "cantrip-os:dev";
    this.image = (await this.json("image", "inspect", image))[0];
    this.id = await this.docker(
      "run",
      "-d",
      "--name",
      this.name,
      "--hostname",
      this.name,
      "--label",
      "io.cantrip.os=foundation",
      "--label",
      "io.cantrip.qa=rust-server-product",
      "--shm-size=1g",
      ...this.volumes.flatMap((name, index) => [
        "--mount",
        `type=volume,source=${name},target=${
          [
            "/home/cantrip",
            "/var/lib/cantrip-os-workspaces",
            "/var/lib/cantrip-os-executor",
          ][index]
        }`,
      ]),
      this.image.Id,
    );
    this.initialId = this.id;
    this.ownedContainers.add(this.id);
    await this.save();
    return this;
  }
  exec(...args) {
    return this.docker("exec", this.id, ...args);
  }
  async fileProof(container, file) {
    const { stdout } = await execute("python3", [
      "-c",
      "import subprocess,tarfile,io,hashlib,json,base64,sys;data=subprocess.check_output(['docker','cp',sys.argv[1]+':'+sys.argv[2],'-']);t=tarfile.open(fileobj=io.BytesIO(data));m=next(x for x in t if x.isfile());b=t.extractfile(m).read();print(json.dumps({'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b),'base64':base64.b64encode(b).decode(),'mode':m.mode,'uid':m.uid,'gid':m.gid}))",
      container,
      file,
    ]);
    const proof = JSON.parse(stdout);
    this.commands.push({ args: ["cp", `${container}:${file}`, "-"], proof });
    return proof;
  }
  async adopt(root) {
    for (const key of [
      "originalContainerId",
      "targetContainerId",
      "retainedContainerId",
    ])
      if (root[key]) this.ownedContainers.add(root[key]);
    const current = (await this.json("inspect", this.name))[0];
    assert.equal(current.Id, root.targetContainerId);
    this.id = current.Id;
    await this.save();
  }
  async target() {
    return this.json(
      "exec",
      this.id,
      "cantrip-workspaces",
      "desktop-target",
      "work",
    );
  }
  async save() {
    await writeFile(
      path.join(this.directory, "guest.json"),
      JSON.stringify(
        {
          name: this.name,
          id: this.id,
          volumes: this.volumes,
          image: this.image,
          initialId: this.initialId,
          ownedContainers: [...this.ownedContainers],
          privateImages: [...this.privateImages],
          commands: this.commands,
        },
        null,
        2,
      ) + "\n",
    );
  }
  async close({ preserve = false } = {}) {
    if (!this.id) return;
    this.ownedContainers = new Set(this.ownedContainers);
    this.privateImages = new Set(this.privateImages);
    const captured = await this.docker(
      "image",
      "ls",
      "--no-trunc",
      "--quiet",
      "--filter",
      `label=io.cantrip.os.system.container=${this.initialId}`,
    );
    for (const id of captured.split("\n").filter(Boolean))
      this.privateImages.add(id);
    const discovered = await this.docker(
      "ps",
      "-aq",
      "--filter",
      `name=^/${this.name}`,
    );
    for (const id of discovered.split("\n").filter(Boolean)) {
      const actual = (await this.json("inspect", id))[0];
      assert.equal(
        actual.Config.Labels["io.cantrip.qa"],
        "rust-server-product",
      );
      this.ownedContainers.add(actual.Id);
      await this.docker("logs", actual.Id);
      await this.docker("stop", "--time", "30", actual.Id);
    }
    this.final = (await this.json("inspect", this.id))[0];
    if (!preserve) {
      for (const [name, source] of [
        ["home", "/home/cantrip"],
        ["workspaces", "/var/lib/cantrip-os-workspaces"],
        ["executor", "/var/lib/cantrip-os-executor"],
      ]) {
        const child = spawn("docker", ["cp", `${this.id}:${source}`, "-"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let diagnostics = "";
        child.stderr.on("data", (data) => {
          diagnostics += data;
        });
        const closed = new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) =>
            code === 0 ? resolve() : reject(new Error(diagnostics)),
          );
        });
        await Promise.all([
          pipeline(
            child.stdout,
            createGzip(),
            createWriteStream(path.join(this.directory, `${name}.tar.gz`)),
          ),
          closed,
        ]);
      }
      for (const id of this.ownedContainers) await this.docker("rm", id);
      await this.docker("volume", "rm", ...this.volumes);
      for (const image of this.privateImages) {
        try {
          await this.docker("image", "rm", image);
        } catch (error) {
          if (!error.stderr?.includes("No such image")) throw error;
        }
      }
      const containers = await this.docker(
        "ps",
        "-aq",
        "--filter",
        `name=^/${this.name}$`,
      );
      assert.equal(containers, "");
    }
    await this.save();
  }
}
