import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = {
  repositoryId: "98213",
  nameWithOwner: "fixture/folder",
  url: "https://github.com/fixture/folder",
};
const route = (id) => `/api/projects/${id}/github-conversion`;

export async function folderConversionFixture(root, git) {
  const bin = path.join(root, "conversion-bin");
  const remote = path.join(root, "folder.git");
  const config = path.join(root, "conversion-gitconfig");
  const responseLoss = path.join(root, "lose-push-reply");
  const pushTrace = path.join(root, "push-trace");
  await mkdir(bin);
  await writeFile(
    config,
    `[url "${pathToFileURL(remote).href}"]\n\tinsteadOf = ${repository.url}.git\n`,
  );
  const environment = {
    PATH: bin,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
    CONVERSION_FIXTURE_GIT: git,
    CONVERSION_FIXTURE_REMOTE: remote,
    CONVERSION_FIXTURE_REPLY: responseLoss,
    CONVERSION_FIXTURE_TRACE: pushTrace,
  };
  const run = async (...args) =>
    (
      await execute(git, args, { env: { ...process.env, ...environment } })
    ).stdout.trim();
  await run("init", "--bare", "--initial-branch=main", remote);
  await writeFile(
    path.join(bin, "git"),
    [
      "#!/bin/bash",
      "set -e",
      'for arg in "$@"; do',
      '  if [ "$arg" = push ]; then',
      '    printf "push\\n" >> "$CONVERSION_FIXTURE_TRACE"',
      '    "$CONVERSION_FIXTURE_GIT" "$@"',
      '    if [ -f "$CONVERSION_FIXTURE_REPLY" ]; then',
      '      /bin/rm "$CONVERSION_FIXTURE_REPLY"',
      "      exit 1",
      "    fi",
      "    exit 0",
      "  fi",
      "done",
      'exec "$CONVERSION_FIXTURE_GIT" "$@"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await writeFile(
    path.join(bin, "gh"),
    [
      "#!/bin/bash",
      "set -e",
      'case "$1/$2" in',
      'api/repos/fixture/folder) printf \'%s\\n\' \'{"id":98213,"full_name":"fixture/folder","html_url":"https://github.com/fixture/folder","default_branch":"main"}\';;',
      "api/graphql)",
      '  refs=$("$CONVERSION_FIXTURE_GIT" --git-dir "$CONVERSION_FIXTURE_REMOTE" for-each-ref)',
      '  if [ -z "$refs" ]; then empty=true; else empty=false; fi',
      '  printf \'{"data":{"repository":{"isEmpty":%s}}}\\n\' "$empty";;',
      "*) exit 1;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return { environment, remote, run, responseLoss, pushTrace };
}

export async function verifyFolderConversion({
  call,
  eventually,
  workerId,
  workerDirectory,
  registerMetadata,
  restartWorker,
  projectLabel,
  workspaceName,
  fixture,
}) {
  const id = "99999999-9999-4999-8999-000000000109";
  const workspaceId = "88888888-8888-4888-8888-000000000109";
  const { run, remote, pushTrace, responseLoss } = fixture;
  const workspace = await call("POST", "/api/workspaces", {
    id: workspaceId,
    nameProtection: {
      ...workspaceName,
      blindIndex: randomBytes(32).toString("base64url"),
    },
    storage: { kind: "managed" },
  });
  assert.equal(workspace.status, 201, JSON.stringify(workspace));
  const folder = await call("POST", "/api/projects/from-folder", {
    id,
    workerId,
    workspaceId,
    nameProtection: projectLabel,
  });
  assert.equal(folder.status, 202, JSON.stringify(folder));
  const wait = (resource, state) =>
    eventually(
      () => call("GET", resource),
      (value) => {
        assert.equal(value.status, 200, JSON.stringify(value));
        assert.equal(value.body.state, state, JSON.stringify(value));
      },
      `native folder conversion ${state}`,
    );
  await wait(`/api/projects/${id}/folder-setup`, "succeeded");
  const checkout = path.join(
    workerDirectory,
    "workspaces",
    workspaceId,
    "folders",
    id,
  );
  const content = path.join(checkout, "readme.txt");
  await writeFile(content, "owned folder contents\n");
  const handles = await registerMetadata(id, {
    ...repository,
    message: "Approved fixture commit",
  });
  const request = {
    repository: {
      repositoryId: handles.repositoryId,
      nameWithOwner: handles.nameWithOwner,
      url: handles.url,
    },
    repositoryBlindIndex: randomBytes(32).toString("base64url"),
  };
  const preview = await call("POST", route(id) + "/preflight", request);
  assert.equal(preview.status, 200, JSON.stringify(preview));
  assert.equal(preview.body.status, "ready", JSON.stringify(preview));
  assert.equal(preview.body.remoteAction, "push");
  assert.equal(preview.body.requiresInitialCommit, true);
  assert.deepEqual(preview.body.repository, request.repository);
  const confirmationToken = createHash("sha256")
    .update(
      JSON.stringify({
        branch: null,
        dirty: false,
        head: null,
        localState: "not-initialized",
        originUrl: null,
        projectId: id,
        repository,
        statusFingerprint: "not-initialized",
      }),
    )
    .digest("hex");
  assert.equal(preview.body.confirmationToken, confirmationToken);
  await assert.rejects(lstat(path.join(checkout, ".git")), { code: "ENOENT" });
  await writeFile(responseLoss, "");
  const started = await call("POST", route(id), {
    ...request,
    workerId,
    projectSourceId: preview.body.projectSourceId,
    confirmationToken,
    initialCommit: { message: handles.message },
  });
  assert.equal(started.status, 202, JSON.stringify(started));
  const { body: blocked } = await wait(route(id), "blocked");
  assert.deepEqual(blocked.error, { code: "push-failed", retryable: true });
  const revision = await run("--git-dir", remote, "rev-parse", "main");
  assert.equal(
    await run("--git-dir", remote, "show", "main:readme.txt"),
    "owned folder contents",
  );
  assert.equal(
    await run("-C", checkout, "log", "-1", "--format=%s"),
    "Approved fixture commit",
  );
  const receipt = path.join(
    workerDirectory,
    "folder-conversions",
    blocked.id + ".json",
  );
  assert.equal(JSON.parse(await readFile(receipt, "utf8")).head, revision);
  await writeFile(content, "leave this local edit untouched\n");
  // The real server requeues retryable conversion jobs on worker reconnect.
  await restartWorker();
  const { body: done } = await wait(route(id), "succeeded");
  assert.equal(done.id, started.body.id);
  assert.equal(done.attempt, 2);
  assert.equal(await run("--git-dir", remote, "rev-parse", "main"), revision);
  assert.equal(await readFile(pushTrace, "utf8"), "push\n");
  assert.equal(
    await readFile(content, "utf8"),
    "leave this local edit untouched\n",
  );
  await assert.rejects(
    lstat(path.join(checkout, ".git", "cantrip-conversion.json")),
    { code: "ENOENT" },
  );
  await assert.rejects(lstat(receipt), { code: "ENOENT" });
  const projects = await call("GET", "/api/projects");
  const converted = projects.body.find((project) => project.id === id);
  assert.equal(converted.originKind, "github");
  assert.equal(converted.capabilities.git, true);
  assert.equal(JSON.stringify(converted).includes(checkout), false);
}
