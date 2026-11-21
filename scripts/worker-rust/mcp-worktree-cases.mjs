import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  decryptRepositoryOperationPayload,
  encryptPrivateDisplayLabel,
  encryptRepositoryOperationPayload,
} from "../../packages/crypto/dist/index.js";
import { discoveryWireFixtures } from "../server-rust/discovery-wire-fixtures.mjs";
import { projectLabel } from "../server-rust/security-fixtures.mjs";
import {
  approveManagedMcpTool,
  managedMcpClient,
  managedMcpRpc,
  managedMcpTurn,
} from "./mcp-tool-cases.mjs";

export async function worktreeFixtureEnvironment(root) {
  const bin = path.join(root, "worktree-fixture-bin");
  await mkdir(bin);
  const git = execFileSync("/usr/bin/which", ["git"], {
    encoding: "utf8",
  }).trim();
  await symlink(git, path.join(bin, "git"));
  return { PATH: bin };
}

export async function verifyManagedMcpWorktrees({
  call,
  eventually,
  createModel,
  encryptedTurn,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  interactionKey,
  repositoryKey,
  data,
  root,
  enableFixtureCatalog,
}) {
  const projectId = randomUUID();
  const workspaceId = randomUUID();
  const projectUrl = "/api/projects/" + projectId;
  const primaryPath = path.join(root, "primary-checkout");
  await mkdir(primaryPath);
  const git = (...args) =>
    execFileSync("git", ["-C", primaryPath, ...args], {
      encoding: "utf8",
    }).trim();
  git("init", "--initial-branch", "main");
  await writeFile(
    path.join(primaryPath, "retained.txt"),
    "Fixture source file\n",
  );
  git("add", "retained.txt");
  git(
    "-c",
    "user.name=cyberpwn",
    "-c",
    "user.email=danielmillst@gmail.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Initialize the owned fixture",
  );
  const head = git("rev-parse", "HEAD");

  const serverId = (await call("GET", "/api/bootstrap", 200)).server.id;
  const operationId = randomUUID();
  const context = {
    serverId,
    projectId,
    worktreeId: workerId,
    operationId,
    direction: "request",
  };
  const material = { ownerId, keyRevision, componentKey: repositoryKey };
  const registered = await call(
    "POST",
    "/api/workers/" + workerId + "/repository-operation",
    200,
    {
      scopeId: projectId,
      operationId,
      access: "write",
      agent: false,
      protectedRequest: await encryptRepositoryOperationPayload({
        ...material,
        context,
        plaintext: new TextEncoder().encode(
          JSON.stringify({
            type: "repository.metadata.register",
            arguments: { values: { path: primaryPath } },
          }),
        ),
      }),
    },
  );
  const opened = await decryptRepositoryOperationPayload({
    ...material,
    context: { ...context, direction: "response" },
    opaque: (registered.operation ?? registered).protectedResponse,
  });
  let handle;
  try {
    const outcome = JSON.parse(new TextDecoder().decode(opened));
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    handle = outcome.result.values.path;
    assert.match(handle, /^ctrr_[A-Za-z0-9_-]{43}$/u);
  } finally {
    opened.fill(0);
  }
  const { nameProtection } =
    discoveryWireFixtures(projectLabel)
      .encryptedProjectWorkspaceCreateSchema[0];
  const label = (kind, id, title) =>
    encryptPrivateDisplayLabel({
      ownerId,
      recordKind: kind,
      rowId: id,
      keyRevision,
      componentKey: labelKey,
      label: title,
    });
  await call("POST", "/api/workspaces", 201, {
    id: workspaceId,
    nameProtection,
    storage: { kind: "managed" },
  });
  await call("POST", "/api/projects/from-folder", 202, {
    id: projectId,
    workerId,
    workspaceId,
    existingPath: handle,
    nameProtection: await label("project", projectId, "Managed MCP Worktrees"),
  });
  await eventually(
    () => call("GET", projectUrl + "/folder-setup", 200),
    ({ state }) => assert.equal(state, "succeeded"),
  );
  await enableFixtureCatalog(projectId);

  const { profile, model } = await createModel("Managed MCP Worktrees");
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: profile.id,
    autoNameChats: false,
  });
  const chatId = randomUUID();
  const chatUrl = "/api/chats/" + chatId;
  await call("POST", projectUrl + "/chats", 201, {
    id: chatId,
    titleProtection: await label("chat", chatId, "Managed MCP Worktrees"),
    autoTitle: false,
  });
  await eventually(
    () => call("GET", chatUrl + "/preparation", 200),
    ({ preparation }) => assert.equal(preparation?.phase, "ready"),
    35_000,
  );

  const attachment = {
    model,
    profile,
    call,
    eventually,
    encryptedTurn,
    chatId,
    chatUrl,
    projectUrl,
  };
  const invoke = managedMcpClient(attachment);
  const lanes = () => call("GET", chatUrl + "/execution-lanes", 200);
  const getChat = async () =>
    (await call("GET", projectUrl + "/chats", 200)).find(
      (chat) => chat.id === chatId,
    );
  const approve = (expectedTool) => () =>
    approveManagedMcpTool({
      call,
      eventually,
      chatId,
      ownerId,
      keyRevision,
      interactionKey,
      expectedTool,
    });
  async function closeLinkedConsole() {
    for (const terminal of await call("GET", projectUrl + "/terminals", 200)) {
      if (terminal.linkedChatId === chatId) {
        await call("DELETE", "/api/terminals/" + terminal.id, 204);
      }
    }
  }
  async function transition(name, args, from, to, afterInvoke) {
    let continuation;
    const [result] = await managedMcpTurn(attachment, [
      {
        name,
        args,
        beforeInvoke: closeLinkedConsole,
        afterInvoke,
        async verify(result) {
          assert.equal(result.continuationScheduled, true);
          assert.equal(result.worktreeId, to);
          assert.equal(result.data.lane.state, "delivering");
          assert.equal(
            result.data.lane.transitionKind,
            name.replace("worktree_", ""),
          );
          assert.equal((await getChat()).activeWorktreeId, from);
          continuation = model.reply({
            text: "Continuation completed in the new worktree.",
          });
        },
      },
    ]);
    await eventually(
      () => continuation.request,
      (request) => assert.equal(request?.completed, true),
      60_000,
    );
    await eventually(
      lanes,
      (entries) => {
        const lane = entries.find(({ id }) => id === result.data.lane.id);
        assert.equal(lane?.state, "active");
        assert.equal(lane.worktreeId, to);
        assert.ok(lane.codexThreadId);
      },
      35_000,
    );
    assert.equal((await getChat()).activeWorktreeId, to);
    await eventually(
      () => call("GET", chatUrl + "/messages", 200),
      ({ messages }) => {
        const input = messages.find(
          (message) =>
            message.role === "system" &&
            message.executionLaneId === result.data.lane.id &&
            message.idempotencyKey ===
              "worktree-continuation:" + result.data.lane.id,
        );
        assert.ok(input?.protectedContent);
      },
    );
    return result;
  }

  const initial = await invoke("worktree_list", {});
  const [primary] = initial.data.worktrees;
  assert.equal(primary.isPrimary, true);
  assert.equal(initial.data.currentWorktreeId, primary.id);
  assert.ok(!Object.hasOwn(primary, "path"));
  const branch = "managed-mcp-fixture-branch";
  const created = await invoke("worktree_create", {
    intent: "newBranch",
    name: "Managed MCP fixture checkout",
    branch,
    baseRevision: head,
  });
  assert.equal(created.data.worktree.origin, "agent");
  assert.match(created.data.worktree.branch, /^ctrr_[A-Za-z0-9_-]{43}$/u);
  assert.ok(!Object.hasOwn(created.data.worktree, "displayPath"));
  const target = created.target;
  const entries = git("worktree", "list", "--porcelain").split("\n\n");
  const secondary = entries.find((entry) =>
    entry.includes("branch refs/heads/" + branch),
  );
  assert.ok(secondary);
  const checkout = await realpath(
    secondary.split("\n")[0].slice("worktree ".length),
  );
  assert.equal(
    await readFile(path.join(checkout, "retained.txt"), "utf8"),
    "Fixture source file\n",
  );
  const page = await invoke("worktree_list", { limit: 1 });
  assert.equal(page.data.nextCursor, 1);
  assert.equal(page.data.total, 2);
  const last = await invoke("worktree_list", {
    limit: 1,
    cursor: page.data.nextCursor,
  });
  assert.equal(last.data.nextCursor, null);
  assert.deepEqual(
    new Set([page.data.worktrees[0].id, last.data.worktrees[0].id]),
    new Set([primary.id, target.worktreeId]),
  );
  await invoke(
    "worktree_switch",
    {
      target: { ...target, projectId: randomUUID() },
      purpose: "Reject another project",
    },
    /different project/iu,
  );

  await transition(
    "worktree_switch",
    { target, purpose: "Continue in the new checkout" },
    primary.id,
    target.worktreeId,
  );
  const dirty = ["fixture-dirty-one", "fixture-dirty-two"].map((name) =>
    path.join(checkout, name),
  );
  for (const name of dirty) await writeFile(name, "untracked fixture\n");
  const status = await invoke("worktree_status", {
    fileLimit: 1,
    branchLimit: 1,
  });
  assert.deepEqual(status.target, target);
  assert.equal(status.data.status.branch, created.data.worktree.branch);
  assert.equal(status.data.status.files.length, 1);
  assert.equal(status.data.filesTruncated, true);
  assert.ok(!Object.hasOwn(status.data.worktree, "path"));
  await managedMcpTurn(attachment, [
    {
      name: "worktree_release",
      args: { purpose: "Do not release a dirty checkout" },
      error: /dirty/iu,
      beforeInvoke: closeLinkedConsole,
      afterInvoke: approve(
        /worktree_release|Release the current Cantrip worktree/iu,
      ),
    },
  ]);
  assert.equal((await getChat()).activeWorktreeId, target.worktreeId);
  for (const name of dirty) await rm(name);
  await transition(
    "worktree_release",
    { purpose: "Return to Primary" },
    target.worktreeId,
    primary.id,
    approve(/worktree_release|Release the current Cantrip worktree/iu),
  );
  const [removed] = await managedMcpTurn(attachment, [
    {
      name: "worktree_remove",
      args: { target },
      afterInvoke: approve(/worktree_remove|Remove a Cantrip worktree/iu),
    },
  ]);
  assert.deepEqual(removed.data, {
    removedWorktreeId: target.worktreeId,
    branchRetained: true,
  });
  assert.equal(git("rev-parse", branch), head);
  await assert.rejects(realpath(checkout), { code: "ENOENT" });

  const settings = await eventually(
    () => call("GET", chatUrl + "/native-settings", 200),
    (state) => assert.ok(state.binding && state.effective),
  );
  await call("PATCH", chatUrl + "/permission-profile", 200, {
    id: ":read-only",
    bindingId: settings.binding.bindingId,
    expectedRevision: settings.permissionPolicy?.revision ?? "0",
    operationId: randomUUID(),
  });
  await eventually(
    () => call("GET", chatUrl + "/native-settings", 200),
    (state) => assert.equal(state.permissionPolicy?.effectiveId, ":read-only"),
  );
  await managedMcpTurn(attachment, [
    {
      name: "worktree_list",
      args: {},
      async verify(result) {
        assert.deepEqual(
          result.data.worktrees.map(({ id, lifecycleState }) => [
            id,
            lifecycleState,
          ]),
          [
            [primary.id, "ready"],
            [target.worktreeId, "missing"],
          ],
        );
        const rpc = await managedMcpRpc(data);
        const { tools } = await rpc("tools/list");
        assert.ok(
          !tools.some(({ name }) =>
            /^worktree_(create|switch|release|remove)$/u.test(name),
          ),
        );
        const denied = await rpc("tools/call", {
          name: "worktree_create",
          arguments: {
            intent: "newBranch",
            name: "Read-only denial fixture",
            branch: "read-only-denial-fixture",
          },
        });
        assert.equal(denied.isError, true);
        assert.equal(
          git("worktree", "list", "--porcelain").split("\n\n").length,
          1,
        );
      },
    },
  ]);
  assert.equal(git("status", "--porcelain"), "");
  console.log(
    JSON.stringify({ suite: "native-managed-mcp-worktrees", passed: true }),
  );
}
