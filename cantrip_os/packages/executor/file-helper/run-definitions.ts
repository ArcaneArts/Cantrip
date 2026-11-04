import { createInterface } from "node:readline";
import { userInfo } from "node:os";
import { cantripOsRunDefinitionRequestSchema } from "@cantrip/protocol/cantrip-os-run";
import { RunConfigurationDefinitionService } from "../../../../cantrip_worker/src/run-configuration-definition-service.js";

// One authenticated native child, not a listener or an agent orchestrator.
// The root is supplied only by the owning Worker's captured Linux placement.
process.umask(0o077);
const root = process.argv[2];
if (!root?.startsWith("/"))
  throw new Error("A captured Linux Primary is required.");
const account = userInfo();
// Native process/start takes an explicit environment. Build the Linux baseline
// from this guest account; never copy the orchestration Worker's environment.
const environment = {
  ...process.env,
  HOME: account.homedir,
  USER: account.username,
  LOGNAME: account.username,
  SHELL: account.shell || "/bin/bash",
  PATH:
    process.env.PATH ??
    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
};
const service = new RunConfigurationDefinitionService({
  emit: () => false,
  environment,
});
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
  for await (const line of lines) {
    if (Buffer.byteLength(line) > 2 * 1024 * 1024)
      throw new Error("Run request is too large.");
    const request = cantripOsRunDefinitionRequestSchema.parse(JSON.parse(line));
    const result = await service.execute({ ...request, sourcePath: root });
    process.stdout.write(JSON.stringify(result) + "\n");
    break;
  }
} finally {
  service.close();
  lines.close();
  process.stdin.destroy();
}
