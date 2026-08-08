import path from "node:path";
import { parseArgs, run, root } from "./lib.mjs";
import { readPatchSeries } from "./patches.mjs";

const args = parseArgs(process.argv.slice(2));
const sourceArg = args.required("source");
const source = path.resolve(root, sourceArg);
const check = args.flag("check");
const series = await readPatchSeries();

for (const item of series) {
  const command = ["apply", "--check", item.patchPath];
  await run("git", command, { cwd: source });
  if (!check) await run("git", ["apply", item.patchPath], { cwd: source });
  console.log(`${check ? "Checked" : "Applied"} ${item.metadata.id}`);
}
console.log(
  `${series.length} Cantrip Code patches ${check ? "checked" : "applied"}`,
);
