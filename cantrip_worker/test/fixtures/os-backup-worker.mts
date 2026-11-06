import { readFile } from "node:fs/promises";
import { CantripOsController } from "../../src/os-executor/controller.js";
import { CantripOsBackupManager } from "../../src/os-executor/backup-manager.js";
import {
  recoveryControl,
  exportRecoveryArchive,
} from "../../src/os-executor/recovery-carrier.js";

const fixture = JSON.parse(await readFile(process.argv[2]!, "utf8"));
const key = Buffer.from(fixture.key, "base64");
const keys = {
  ownerId: () => fixture.command.scope.ownerId,
  serverIdentity: () => fixture.command.scope.serverId,
  componentKey: (_scope: string, revision = 1) => {
    if (revision !== 1)
      throw new Error("Fixture grant revision is unavailable");
    return { key: new Uint8Array(key), keyRevision: revision };
  },
};
const controller = new CantripOsController(
  fixture.directory,
  fixture.command.scope.workerId,
);
const manager = new CantripOsBackupManager(
  fixture.directory,
  fixture.command.scope.workerId,
  controller,
  keys,
  {
    exportArchive: exportRecoveryArchive,
    control: async (input) => {
      const result = await recoveryControl(input);
      if (input.args.includes(fixture.pauseAfter)) {
        process.send?.({
          checkpoint: fixture.pauseAfter,
          operationId: result.operation_id,
        });
        process.kill(process.pid, "SIGSTOP");
      }
      return result;
    },
  },
);
try {
  const result = await manager.handle(fixture.command);
  process.send?.({ result });
} finally {
  key.fill(0);
  process.disconnect?.();
}
