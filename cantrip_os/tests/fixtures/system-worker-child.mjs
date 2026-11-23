import { appendFile, readFile, writeFile } from "node:fs/promises";
import { LocalDocker } from "../../host/index.mjs";
import { workerCommandSchema } from "../../../packages/protocol/dist/index.js";
const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const { CantripOsSystemManager } = await import(config.managerModule);
const engine = await LocalDocker.current(),
  request = engine.request.bind(engine);
engine.request = async (method, path, body, options) => {
  await appendFile(config.trace, JSON.stringify({ method, path }) + "\n", {
    mode: 0o600,
  });
  const receipt = await request(method, path, body, options);
  if (
    method === "POST" &&
    ((config.hold === "create" && path.startsWith("/containers/create?")) ||
      (config.hold === "start" &&
        path === `/containers/${config.holdId}/start`))
  ) {
    await writeFile(
      config.marker,
      JSON.stringify({ pid: process.pid, path, receipt }),
      { mode: 0o600 },
    );
    process.send?.({ held: config.hold });
    await new Promise(() => {
      setInterval(() => {}, 1000);
    });
  }
  return receipt;
};
const keys = {
  ownerId: () => config.command.scope.ownerId,
  serverIdentity: () => config.command.scope.serverId,
  componentKey: (_scope, revision = 1) => {
    if (revision !== 1) throw new Error("Unknown fixture key revision");
    return {
      key: new Uint8Array(Buffer.from(config.key, "base64")),
      keyRevision: 1,
    };
  },
};
const manager = new CantripOsSystemManager(
  config.directory,
  config.command.scope.workerId,
  keys,
  async () => engine,
);
try {
  const result = await manager.handle(
    workerCommandSchema.parse(config.command),
  );
  process.send?.({ unexpectedResult: result });
  process.exitCode = 2;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
