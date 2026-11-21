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
