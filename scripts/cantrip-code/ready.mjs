import process from "node:process";
import {
  getBuildIdentity,
  normalizeTarget,
  verifyBuild,
} from "./build-lib.mjs";
import { parseArgs } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const target = normalizeTarget(args.optional("target"));
const identity = await getBuildIdentity(target);
await verifyBuild(identity);
if (args.flag("json")) {
  console.log(
    JSON.stringify({
      target: target.id,
      fingerprint: identity.fingerprint,
      installationRoot: identity.cacheDirectory,
      distributionDirectory: identity.distributionDirectory,
      manifestPath: identity.manifestPath,
    }),
  );
} else {
  console.log(
    `Cantrip Code ${target.id} build ${identity.fingerprint.slice(0, 12)} is ready`,
  );
}
