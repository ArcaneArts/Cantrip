// Network-free lifecycle mutations and failed-step log reads over native gh.
import { execFileSync } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { pullRequestActionsFixture } from "./pull-request-actions-fixture.mjs";
export async function pullRequestLifecycleFixture(root, bin) {
  const fixture = await pullRequestActionsFixture(root, bin);
  const executable = path.join(bin, "gh");
  let script = await readFile(executable, "utf8");
  script = script.replace(
    "  api:graphql:*)",
    `  pr:ready:*) operation=ready ;;
  run:view:*) operation=log-$3 ;;
  api:repos/*/pulls/43/update-branch:PUT) operation=updateBranch ;;
  api:repos/*/pulls/43/merge:PUT) operation=merge ;;
  api:graphql:*)`,
  );
  script = script.replace(
    "        query=*CantripPullRequestReviewContext*)",
    `        query=*CantripConvertPullRequestToDraft*) operation=convertDraft ;;
        query=*CantripEnableAutoMerge*) operation=enableAuto ;;
        query=*CantripDisableAutoMerge*) operation=disableAuto ;;
        query=*CantripEnqueuePullRequest*) operation=enqueue ;;
        query=*CantripDequeuePullRequest*) operation=dequeue ;;
        query=*CantripPullRequestReviewContext*)`,
  );
  script = script.replace(
    "  createPull|labels|",
    "  ready|updateBranch|merge|convertDraft|enableAuto|disableAuto|enqueue|dequeue|createPull|labels|",
  );
  await writeFile(executable, script, { mode: 0o700 });
  const reset = fixture.reset;
  const operations = [
    "ready",
    "updateBranch",
    "merge",
    "convertDraft",
    "enableAuto",
    "disableAuto",
    "enqueue",
    "dequeue",
  ];
  fixture.reset = async () => {
    await reset();
    for (const op of operations) {
      await fixture.response(op, op === "merge" ? { merged: true } : {});
      for (const field of ["pull", "context", "viewed"])
        await rm(path.join(fixture.directory, `${op}.after-${field}`), {
          force: true,
        });
    }
    for (const id of ["7", "8", "9", "10", "11", "12"])
      await fixture.response("log-" + id, "Owned failed step 😀\n", {
        raw: true,
        stderr: "stderr tail\n",
      });
  };
  fixture.bindFetch = async (bare) => {
    const git = execFileSync("/usr/bin/which", ["git"], {
      encoding: "utf8",
    }).trim();
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    // Unlink the owned shim/symlink before writing; never follow a link into Git.
    await rm(path.join(bin, "git"));
    await writeFile(
      path.join(bin, "git"),
      `#!/bin/sh
if test "$3:$4" = fetch:--no-tags; then
  exec ${quote(git)} -c ${quote("url." + bare + ".insteadOf=https://github.com/ArcaneArts/Cantrip.git")} "$@"
fi
exec ${quote(git)} "$@"
`,
      { mode: 0o700 },
    );
  };
  await fixture.reset();
  return fixture;
}
