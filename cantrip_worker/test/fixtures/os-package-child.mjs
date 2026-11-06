import { appendFile, readFile, writeFile } from "node:fs/promises";
import { CantripOsPackageManager } from "../../dist/os-executor/package-manager.js";
import { LocalDocker, packageControl } from "@cantrip/os-host";

const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const keys = {
  ownerId: () => config.command.scope.ownerId,
  serverIdentity: () => config.command.scope.serverId,
  componentKey: () => ({
    keyRevision: 1,
    key: new Uint8Array(Buffer.from(config.key, "base64")),
  }),
};
const manager = new CantripOsPackageManager(
  config.directory,
  config.command.scope.workerId,
  keys,
  config.catalog,
  {
    docker: () => LocalDocker.current(),
    control: async (transport, args, options) => {
      const offset = args[0] === "--expect" ? 2 : 0;
      const action = args[offset];
      if (["admit", "receive", "start", "abandon"].includes(action))
        await appendFile(
          config.dispatchLog,
          JSON.stringify({
            action,
            operationId: config.command.operationId,
            at: Date.now(),
            pid: process.pid,
          }) + "\n",
          { mode: 0o600 },
        );
      const result = await packageControl(transport, args, options);
      if (action === config.hold) {
        await writeFile(
          config.barrier,
          JSON.stringify({ pid: process.pid, action, result }),
          { mode: 0o600 },
        );
        // A live timer holds the actual Worker-manager process until the test
        // kills it. An unresolved Promise alone would let Node exit.
        await new Promise(() => {
          setInterval(() => {}, 1000);
        });
      }
      return result;
    },
  },
);
await manager.handle(config.command);
