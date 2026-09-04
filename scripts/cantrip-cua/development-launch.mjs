import path from "node:path";
import { fileURLToPath } from "node:url";
import { developmentCuaPaths } from "./development.mjs";

export function developmentWorkerEnvironment({
  environment = process.env,
  ...pathOptions
} = {}) {
  const paths = developmentCuaPaths({ ...pathOptions, environment });
  return {
    ...environment,
    CANTRIP_DEV_PROFILE: paths.profileName,
    CANTRIP_CUA_BIN: environment.CANTRIP_CUA_BIN ?? paths.binary,
  };
}

export async function runDevelopmentWorker({
  argv = process.argv,
  environment = process.env,
  cliUrl = import.meta.resolve("tsx/cli"),
  workerUrl = new URL("../../cantrip_worker/src/index.ts", import.meta.url),
  loadCli = () => import("tsx/cli"),
} = {}) {
  Object.assign(environment, developmentWorkerEnvironment({ environment }));
  // Keep tsx watch in this process so its existing signal and restart handling
  // remains in charge, with no extra wrapper child or shell quoting layer.
  argv.splice(1, 1, fileURLToPath(cliUrl), "watch", fileURLToPath(workerUrl));
  await loadCli();
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runDevelopmentWorker();
}
