import path from "node:path";
import { parseArgs, run, root } from "./lib.mjs";
import { readPatchSeries } from "./patches.mjs";

const args = parseArgs(process.argv.slice(2));
const sourceArg = args.required("source");
const source = path.resolve(root, sourceArg);
const check = args.flag("check");
const series = await readPatchSeries();
const applyOptions = {
  cwd: source,
  // A source tree may itself sit below Cantrip's worktree. Prevent Git from
  // treating that parent repository as the patch target, which otherwise
  // makes source-relative patches look out of scope and silently skips them.
  env: { GIT_CEILING_DIRECTORIES: path.dirname(source) },
};

for (const item of series) {
  const command = [
    "apply",
    "--no-index",
    "--unsafe-paths",
    "--ignore-space-change",
    "--check",
    item.patchPath,
  ];
  await run("git", command, applyOptions);
  if (!check) {
    await run(
      "git",
      [
        "apply",
        "--no-index",
        "--unsafe-paths",
        "--ignore-space-change",
        item.patchPath,
      ],
      applyOptions,
    );
  }
  console.log(`${check ? "Checked" : "Applied"} ${item.metadata.id}`);
}
console.log(
  `${series.length} Cantrip Code patches ${check ? "checked" : "applied"}`,
);
