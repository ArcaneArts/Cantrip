import { readFile } from "node:fs/promises";
import { CantripOsController } from "../../src/os-executor/controller.js";
import {
  OsRunExecution,
  type OsRunLaunch,
} from "../../src/os-executor/run-execution.js";
import { RunConfigurationRuntimeSupervisor } from "../../src/run-configuration-runtime-supervisor.js";

// Disposable acceptance worker: its parent deliberately SIGKILLs it while a
// real native process is running, then reconciles from the durable journal.
const input = JSON.parse(await readFile(process.argv[2]!, "utf8")) as {
  directory: string;
  workerId: string;
  ownerId: string;
  serverId: string;
  launch: OsRunLaunch;
};
const controller = new CantripOsController(input.directory, input.workerId);
const supervisor = new RunConfigurationRuntimeSupervisor({
  authorize: async () => {
    throw new Error("Linux Run reached Host authorization");
  },
  linux: new OsRunExecution(
    input.directory,
    controller,
    { ownerId: () => input.ownerId, serverIdentity: () => input.serverId },
    async () => {
      throw new Error("This fixture has no secrets");
    },
  ),
});
await supervisor.start({
  type: "cantrip-os.run-runtime.start",
  ...input.launch,
});
