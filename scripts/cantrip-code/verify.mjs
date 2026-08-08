import path from "node:path";
import process from "node:process";
import {
  getBuildIdentity,
  normalizeTarget,
  verifyBuild,
} from "./build-lib.mjs";
import { codeRoot, parseArgs, run } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
await run(process.execPath, [
  path.join(codeRoot, "..", "scripts", "cantrip-code", "verify-upstream.mjs"),
]);
const target = normalizeTarget(args.optional("target"));
const identity = await getBuildIdentity(target);
const manifest = await verifyBuild(identity, { full: true });
console.log(
  `Verified Cantrip Code ${manifest.version} ${target.id} ` +
    `${manifest.fingerprint.slice(0, 12)} (${manifest.files.length} files)`,
);
