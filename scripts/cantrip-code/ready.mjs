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
await verifyBuild(identity, { full: args.flag("full") });
console.log(
  `Cantrip Code ${target.id} build ${identity.fingerprint.slice(0, 12)} is ready`,
);
