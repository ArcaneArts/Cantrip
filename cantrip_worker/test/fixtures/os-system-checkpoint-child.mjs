import { appendFile, readFile, writeFile } from "node:fs/promises";
import { CantripOsSystemCheckpointManager } from "../../dist/os-executor/system-checkpoints.js";
import { sealPrivateSystem } from "../../dist/os-executor/private-system-file.js";
import { LocalDocker } from "@cantrip/os-host";

const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const engine = await LocalDocker.current();
const request = engine.request.bind(engine);
engine.request = async (method, path, body, options) => {
  await appendFile(config.trace, JSON.stringify({ method, path }) + "\n", {
    mode: 0o600,
  });
  return request(method, path, body, options);
};
const readStream = engine.readStream.bind(engine);
engine.readStream = async (path, options) => {
  await appendFile(
    config.trace,
    JSON.stringify({ method: "STREAM", path }) + "\n",
    { mode: 0o600 },
  );
  return readStream(path, options);
};
const keys = {
  ownerId: () => config.admission.context.ownerId,
  serverIdentity: () => config.admission.context.serverId,
  componentKey: (_component, revision = 1) => {
    if (revision !== 1) throw new Error("Missing fixture key revision");
    return {
      key: new Uint8Array(Buffer.from(config.key, "base64")),
      keyRevision: 1,
    };
  },
};
async function hold(receipt) {
  await writeFile(
    config.marker,
    JSON.stringify({ pid: process.pid, receipt }),
    { mode: 0o600 },
  );
  process.send?.({ held: config.fault });
  // A pending Promise alone does not keep Node alive. Hold a real event-loop
  // handle so the parent, rather than Node's unsettled-await exit, kills us.
  await new Promise(() => {
    setInterval(() => {}, 1_000);
  });
}
const manager = new CantripOsSystemCheckpointManager(
  config.directory,
  config.admission.context.workerId,
  keys,
  {
    docker: async () => engine,
    seal: async (input) => {
      if (config.fault === "partial") {
        async function* interrupted() {
          let bytes = 0;
          for await (const chunk of input.archive) {
            yield chunk;
            bytes += chunk.byteLength;
            if (bytes >= 2 * 1_048_576) await hold({ bytes });
          }
        }
        return sealPrivateSystem({ ...input, archive: interrupted() });
      }
      const result = await sealPrivateSystem(input);
      await hold(result);
      return result;
    },
  },
);
try {
  const result = await manager.run(config.admission, "execute");
  process.send?.({ unexpectedResult: result });
  process.exitCode = 2;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
