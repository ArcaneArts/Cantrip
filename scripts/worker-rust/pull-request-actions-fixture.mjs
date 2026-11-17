// Owned gh mutation boundary; no network, account, or production side effects.
import { writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pullRequestFixture, pullFixture } from "./pull-request-fixture.mjs";
export async function pullRequestActionsFixture(root, bin) {
  const fixture = await pullRequestFixture(root, bin);
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const operations = [
    "createPull",
    "labels",
    "deleteLabel",
    "reviewers",
    "deleteReviewers",
    "comment",
    "reply",
    "submitRest",
    "patchPull",
    "createReview",
    "addThread",
    "submitReview",
    "deleteReview",
    "resolveThread",
    "unresolveThread",
    "markViewed",
    "unmarkViewed",
  ];
  await writeFile(
    path.join(bin, "gh"),
    `#!/bin/sh
fixture=${quote(fixture.directory)}
printf '%s\\0' "$@" > "$fixture/calls/$$"
method=GET
previous=
for argument in "$@"; do
  if test "$previous" = --method; then method=$argument; fi
  previous=$argument
done
case "$1:$2:$method" in
  api:graphql:*)
    operation=unknown
    for argument in "$@"; do
      case "$argument" in
        query=*CantripPullRequestReviewContext*) operation=context ;;
        query=*CantripPullRequestFileStates*) operation=viewed ;;
        query=*CantripCreatePendingReview*) operation=createReview ;;
        query=*CantripAddPendingReviewThread*) operation=addThread ;;
        query=*CantripSubmitPendingReview*) operation=submitReview ;;
        query=*CantripDeletePendingReview*) operation=deleteReview ;;
        query=*CantripSetReviewThreadUnresolved*) operation=unresolveThread ;;
        query=*CantripSetReviewThreadResolved*) operation=resolveThread ;;
        query=*CantripUnmarkFileViewed*) operation=unmarkViewed ;;
        query=*CantripMarkFileViewed*) operation=markViewed ;;
      esac
    done ;;
  api:repos/*/git/ref/heads/*:GET) operation=remoteRef ;;
  api:repos/*/pulls:POST) operation=createPull ;;
  api:repos/*/pulls/43:PATCH) operation=patchPull ;;
  api:repos/*/issues/43/labels:POST) operation=labels ;;
  api:repos/*/issues/43/labels/*:DELETE) operation=deleteLabel ;;
  api:repos/*/pulls/43/requested_reviewers:POST) operation=reviewers ;;
  api:repos/*/pulls/43/requested_reviewers:DELETE) operation=deleteReviewers ;;
  api:repos/*/issues/43/comments:POST) operation=comment ;;
  api:repos/*/pulls/43/comments/*/replies:POST) operation=reply ;;
  api:repos/*/pulls/43/reviews:POST) operation=submitRest ;;
  api:repos/*/pulls/43:GET) operation=pull ;;
  api:repos/*/pulls/43/files:GET) operation=files ;;
  api:repos/*/pulls/43/commits:GET) operation=commits ;;
  api:repos/*/pulls/43/reviews:GET) operation=reviews ;;
  api:repos/*/pulls/43/comments:GET) operation=reviewComments ;;
  api:repos/*/issues/43/comments:GET) operation=conversation ;;
  api:repos/*/commits/*/check-runs:GET) operation=checks ;;
  api:repos/*/commits/*/status:GET) operation=statuses ;;
  *) printf 'Unexpected owned gh invocation' >&2; exit 91 ;;
esac
case "$operation" in
  createPull|labels|deleteLabel|reviewers|deleteReviewers|comment|reply|submitRest|patchPull|createReview|addThread|submitReview|deleteReview|resolveThread|unresolveThread|markViewed|unmarkViewed)
    printf '%s\\n' "$operation" >> "$fixture/mutations"
    if test "$(/bin/cat "$fixture/$operation.status")" = 0; then
      for field in pull context viewed; do
        if test -e "$fixture/$operation.after-$field"; then /bin/cp "$fixture/$operation.after-$field" "$fixture/$field.stdout"; fi
      done
    fi ;;
esac
if test -e "$fixture/$operation.hold"; then
  : > "$fixture/$operation.started"
  while ! test -e "$fixture/$operation.release"; do /bin/sleep 0.01; done
fi
/bin/cat "$fixture/$operation.stdout"
/bin/cat "$fixture/$operation.stderr" >&2
exit "$(/bin/cat "$fixture/$operation.status")"
`,
    { mode: 0o700 },
  );
  const reset = fixture.reset;
  fixture.reset = async () => {
    await reset();
    await writeFile(path.join(fixture.directory, "mutations"), "");
    for (const op of operations) {
      await fixture.response(
        op,
        op === "createPull"
          ? pullFixture
          : op === "createReview"
            ? {
                data: {
                  addPullRequestReview: {
                    pullRequestReview: { id: "new-review" },
                  },
                },
              }
            : {},
      );
      for (const field of ["pull", "context", "viewed"])
        await rm(path.join(fixture.directory, `${op}.after-${field}`), {
          force: true,
        });
    }
    await fixture.response("remoteRef", { object: { sha: "a".repeat(40) } });
  };
  fixture.after = (op, field, value) =>
    writeFile(
      path.join(fixture.directory, `${op}.after-${field}`),
      JSON.stringify(value),
    );
  fixture.mutations = async () =>
    (await readFile(path.join(fixture.directory, "mutations"), "utf8"))
      .split("\n")
      .filter(Boolean);
  await fixture.reset();
  return fixture;
}
