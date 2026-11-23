// Native external-tool boundary for owned, network-free replica fixtures.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const execute = promisify(execFile);
export async function replicaProvisionFixture(parent, git) {
  const root = path.join(parent, "replica-fixture");
  const bin = path.join(root, "bin"),
    seed = path.join(root, "seed");
  const remote = path.join(root, "remotes", "fixture", "repository.git"),
    empty = path.join(root, "remotes", "fixture", "empty.git");
  const config = path.join(root, "gitconfig"),
    trace = path.join(root, "trace");
  const behavior = path.join(root, "behavior");
  await mkdir(bin, { recursive: true });
  await mkdir(seed);
  await mkdir(path.dirname(remote), { recursive: true });
  const names = ["repository", "direct", "link", "held", "empty"];
  await writeFile(
    config,
    names
      .map(
        (name) =>
          '[url "' +
          pathToFileURL(path.join(path.dirname(remote), name + ".git")).href +
          '"]\n\tinsteadOf = https://github.com/fixture/' +
          name +
          ".git\n",
      )
      .join(""),
  );
  await writeFile(trace, "");
  await writeFile(behavior, "normal");
  const environment = {
    PATH: bin,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
    GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
    CANTRIP_REPLICA_FIXTURE_GIT: git,
    CANTRIP_REPLICA_FIXTURE_TRACE: trace,
    CANTRIP_REPLICA_FIXTURE_BEHAVIOR: behavior,
    CANTRIP_REPLICA_FIXTURE_REMOTE: remote,
    CANTRIP_REPLICA_FIXTURE_EMPTY: empty,
    CANTRIP_REPLICA_FIXTURE_REMOTES: path.join(root, "remotes"),
  };
  const env = { ...process.env, ...environment };
  const run = async (...args) =>
    (await execute(git, args, { env })).stdout.trim();
  await run("init", "--initial-branch=main", seed);
  await mkdir(path.join(seed, ".cantrip"));
  await writeFile(path.join(seed, "README.md"), "Owned replica fixture\n");
  await writeFile(
    path.join(seed, ".cantrip", "project.json"),
    JSON.stringify({ worktreePolicy: "agent-managed" }) + "\n",
  );
  await run("-C", seed, "add", ".");
  await run("-C", seed, "commit", "-m", "Fixture");
  const revision = await run("-C", seed, "rev-parse", "HEAD");
  await run("init", "--bare", "--initial-branch=main", remote);
  await run("-C", seed, "push", remote, "main");
  for (const name of names.filter(
    (name) => !["repository", "empty"].includes(name),
  )) {
    await run(
      "init",
      "--bare",
      "--initial-branch=main",
      path.join(path.dirname(remote), name + ".git"),
    );
    await run(
      "-C",
      seed,
      "push",
      path.join(path.dirname(remote), name + ".git"),
      "main",
    );
  }
  await run("init", "--bare", "--initial-branch=main", empty);
  await writeFile(
    path.join(bin, "git"),
    [
      "#!/bin/bash",
      "set -e",
      'printf "%s\\0" "git" "$@" "" >> "$CANTRIP_REPLICA_FIXTURE_TRACE"',
      'exec "$CANTRIP_REPLICA_FIXTURE_GIT" "$@"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await writeFile(
    path.join(bin, "gh"),
    [
      "#!/bin/bash",
      "set -e",
      'printf "%s\\0" "gh" "$@" "" >> "$CANTRIP_REPLICA_FIXTURE_TRACE"',
      'if [ "$1" != "repo" ] || [ "$2" != "clone" ]; then exit 91; fi',
      'behavior="$(/bin/cat "$CANTRIP_REPLICA_FIXTURE_BEHAVIOR")"',
      'if [ "$behavior" = "fail" ]; then',
      '  /bin/mkdir -p "$4"',
      '  printf "%s\\n" "partial fixture" > "$4/partial.txt"',
      '  printf "%s\\n" "progress chatter" "fatal: owned remote refused clone" >&2',
      "  exit 7",
      "fi",
      'if [ "$behavior" = "hold-once" ]; then',
      '  printf "%s\\n" "fail" > "$CANTRIP_REPLICA_FIXTURE_BEHAVIOR"',
      '  printf "%s\\n" "$$" > "$CANTRIP_REPLICA_FIXTURE_BEHAVIOR.holding"',
      "  /bin/sleep 60",
      "fi",
      'if [ "$behavior" = "slow" ]; then /bin/sleep 0.05; fi',
      'remote="$CANTRIP_REPLICA_FIXTURE_REMOTES/$3.git"',
      'printf "Receiving objects: 50%%\\r" >&2',
      '"$CANTRIP_REPLICA_FIXTURE_GIT" clone --progress "$remote" "$4"',
      '"$CANTRIP_REPLICA_FIXTURE_GIT" -C "$4" remote set-url origin "https://github.com/$3.git"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return {
    root,
    bin,
    remote,
    empty,
    trace,
    behavior,
    seed,
    revision,
    environment,
  };
}
