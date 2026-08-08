import path from "node:path";
import {
  downloadUpstream,
  exists,
  parseArgs,
  readJson,
  root,
  upstreamConfigPath,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const config = await readJson(upstreamConfigPath);
const sha = args.optional("sha") ?? config.openvscodeServerCommit;
const output = path.resolve(
  root,
  args.optional("output") ?? path.join(".cantrip-code", "fetched", sha),
);

if (await exists(output)) {
  throw new Error(
    `${output} already exists; remove it explicitly or select another --output`,
  );
}

await downloadUpstream({ sha, output });
console.log(
  `Fetched OpenVSCode Server ${sha} to ${path.relative(root, output)}`,
);
