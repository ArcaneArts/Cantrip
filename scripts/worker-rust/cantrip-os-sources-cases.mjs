import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as crypto from "../../packages/crypto/dist/index.js";
import { repositoryFixture } from "../server-rust/repository-fixture.mjs";
import { projectLabel } from "../server-rust/security-fixtures.mjs";
import { literal } from "../server-rust/project-target-state.mjs";

const ownerId = "00000000-0000-0000-0000-000000000001";

// Only project metadata is seeded, in an owned stopped profile. The production
// HTTP routes, encryption, worker journal and guest executor do the provisioning.
export async function seedProjects(executable, root, dataDirectory) {
  const projects = { folder: randomUUID(), git: randomUUID() };
  const repo = await repositoryFixture({
    kind: "rust",
    executable: path.resolve(executable),
    root,
    dataDirectory,
    databaseMode: "pglite",
  });
  try {
    for (const [kind, id] of Object.entries(projects)) {
      await repo.seed(
        "INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,worktree_policy,git_capability,github_capability) VALUES(" +
          [
            literal(id),
            literal(ownerId),
            literal(JSON.stringify(projectLabel)),
            "'managed-folder'",
            "'managed'",
            "'direct'",
            kind === "git",
            false,
          ].join(",") +
          ")",
      );
    }
  } finally {
    await repo.close();
  }
  return projects;
}

async function grant(call, workerId, data) {
  const identity = JSON.parse(
    await readFile(path.join(data, "worker-encryption-key.json"), "utf8"),
  );
  const accountMasterKey = crypto.generateAccountMasterKey();
  const clientId = randomUUID();
  const publicKey = await crypto.publicKeyForPair(
    await crypto.generateHpkeKeyPair(),
  );
  const wrappedMasterKey = await crypto.wrapAccountMasterKeyForClient({
    ownerId,
    clientId,
    accountMasterKey,
    masterKeyRevision: 1,
    clientPublicKey: publicKey,
  });
  await call(
    "POST",
    "/api/encryption/profile/initialize",
    {
      profile: {
        formatVersion: 1,
        activeMasterKeyRevision: 1,
        passwordKdf: null,
        passwordWrappedMasterKey: null,
        payloadMigrationStatus: "pending",
      },
      initialClient: {
        id: clientId,
        label: "Cantrip OS source fixture",
        publicKey,
        wrappedMasterKey,
      },
    },
    201,
  );
  const refresh = () =>
    call("POST", `/api/workers/${workerId}/encryption/refresh`, {
      component: "repository-content",
      keyRevision: 1,
    });
  await refresh();
  const principals = await call("GET", "/api/encryption/principals");
  const principal = principals.find(({ id }) => id === identity.principalId);
  assert.ok(principal);
  await call("POST", `/api/encryption/principals/${principal.id}/approve`, {
    expectedRevision: principal.revision,
  });
  const componentKey = crypto.deriveComponentKey({
    accountMasterKey,
    ownerId,
    component: "repository-content",
    keyRevision: 1,
  });
  const wrappedKey = await crypto.wrapComponentKeyForWorker({
    ownerId,
    workerId,
    component: "repository-content",
    keyRevision: 1,
    componentKey,
    workerPublicKey: identity.publicKey,
  });
  await call(
    "POST",
    `/api/encryption/principals/${principal.id}/grants`,
    {
      component: "repository-content",
      keyRevision: 1,
      wrappedKey,
    },
    201,
  );
  assert.equal((await refresh()).status.state, "ready");
  return componentKey;
}

export async function verifySources({
  call,
  projects,
  os,
  actual,
  workerId,
  data,
  bootstrap,
  hash,
  container,
  docker,
  eventually,
  linked: linkedFixture,
  runDefinitions,
  stopWorker,
  restartWorker,
}) {
  assert.equal(os.ownerId, ownerId);
  const componentKey = await grant(call, workerId, data);
  const serverId = bootstrap.server.id;
  const workspaces = await call("GET", `/api/cantrip-os/${os.id}/workspaces`);
  const workspace = workspaces.find(
    (entry) => entry.guestWorkspaceId === actual.id,
  );
  assert.ok(workspace);
  const guest = (...args) =>
    docker(
      "exec",
      "--user",
      String(actual.uid),
      "-e",
      `HOME=${actual.home}`,
      container,
      ...args,
    );
  const bindings = (project) => `/api/projects/${project}/cantrip-os/bindings`;
  const route = (binding) => bindings(binding.projectId) + "/" + binding.id;
  const bind = (
    kind,
    input = {
      mode: "linux-owned",
      workspaceId: workspace.id,
      sourceKind: kind,
    },
  ) => call("POST", bindings(projects[kind]), input);

  async function submit(binding, intent, prepared = () => {}) {
    const operationId = randomUUID();
    const protectedRequest = await crypto.encryptRepositoryOperationPayload({
      ownerId,
      keyRevision: 1,
      componentKey,
      context: {
        serverId,
        projectId: binding.projectId,
        worktreeId: binding.worktreeId,
        operationId,
        direction: "request",
      },
      plaintext: new TextEncoder().encode(
        JSON.stringify({
          type: "cantrip-os.source.provision",
          instanceId: os.id,
          workspaceId: workspace.id,
          bindingId: binding.id,
          bindingGeneration: binding.bindingGeneration,
          intent,
        }),
      ),
    });
    const input = {
      operationId,
      bindingGeneration: binding.bindingGeneration,
      protectedRequest,
    };
    const key = hash([serverId, ownerId, workerId, os.id, os.guestInstanceId]);
    const journal = path.join(
      data,
      "cantrip-os-operations",
      key,
      operationId + ".json",
    );
    prepared(operationId, journal);
    const outcome = await call("POST", route(binding) + "/provision", input);
    const record = JSON.parse(await readFile(journal, "utf8"));
    return { input, outcome, record };
  }

  async function provision(binding, source, state = "ready") {
    const intent = { mode: "linux-owned", source };
    const { input, outcome, record } = await submit(binding, intent);
    assert.equal(outcome.state, state, record.error ?? JSON.stringify(outcome));
    assert.equal(
      record.admissionFingerprint,
      hash(["cantrip-os.source.provision", intent]),
    );
    assert.equal(record.native.binding.workspace_id, actual.id);
    assert.ok(record.native.sessionId);
    assert.ok(record.processes.length > 0);
    assert.equal(
      new Set(record.processes.map((p) => p.processId)).size,
      record.processes.length,
    );
    const publicReceipt = structuredClone(outcome.receipt);
    if (record.receipt?.source.branch) {
      const token = publicReceipt.source.branch;
      assert.match(token, /^ctrr_[\w-]{43}$/u);
      const registry = JSON.parse(
        await readFile(path.join(data, "repository-routing.json"), "utf8"),
      );
      publicReceipt.source.branch = registry.records.find(
        (entry) => entry.field === "branch" && entry.token === token,
      )?.value;
    }
    assert.deepEqual(record.receipt, publicReceipt);
    return { input, outcome, record, source: publicReceipt?.source };
  }

  const folder = await bind("folder");
  const made = await provision(folder, { kind: "folder" });
  assert.equal(made.source.head, null);
  await guest("test", "-d", folder.guestPath);
  assert.equal((await call("POST", route(folder) + "/verify")).state, "ready");

  // Retain a target that predates dispatch and observe the actual atomic
  // publication failure. Its contents and the operation evidence both survive.
  const occupied = await bind("folder");
  await guest("mkdir", occupied.guestPath);
  await guest("touch", occupied.guestPath + "/keep");
  const collision = await provision(occupied, { kind: "folder" }, "failed");
  assert.deepEqual(
    collision.record.processes.map((p) => p.argv[0]),
    ["python3"],
  );
  await guest("test", "-f", occupied.guestPath + "/keep");

  const relativePath = "seed % # 日本語";
  const seed = actual.home + "/" + relativePath;
  await guest("git", "init", "--initial-branch=fixture", seed);
  await guest("touch", seed + "/kept.txt");
  await guest("git", "-C", seed, "add", "--", "kept.txt");
  await guest(
    "git",
    "-C",
    seed,
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "user.name=Fixture",
    "commit",
    "-m",
    "Fixture",
  );
  const revision = await guest("git", "-C", seed, "rev-parse", "HEAD");

  const managed = await bind("git");
  const checkout = await provision(managed, {
    kind: "git",
    repositoryUrl: pathToFileURL(seed).href,
    revision,
  });
  assert.equal(checkout.source.head, revision);
  assert.equal(checkout.source.detached, true);
  assert.equal(checkout.source.branch, null);
  assert.equal(checkout.source.gitCommonGuestPath, managed.guestPath + "/.git");
  assert.equal(
    checkout.source.repositoryFingerprint,
    hash({
      instance: os.guestInstanceId,
      workspace: actual.id,
      common: checkout.source.gitCommonGuestPath,
    }),
  );
  await guest("test", "-f", managed.guestPath + "/kept.txt");
  assert.equal((await call("POST", route(managed) + "/verify")).state, "ready");

  const tree = await bind("git", {
    mode: "linux-worktree",
    sourceBindingId: managed.id,
    operationId: randomUUID(),
    expectedRuntimeGeneration: os.runtimeGeneration,
  });
  const linked = await provision(tree, {
    kind: "git-worktree",
    revision,
    branch: "second",
  });
  assert.equal(linked.source.branch, "second");
  assert.equal(linked.source.head, revision);
  assert.equal(
    linked.source.repositoryFingerprint,
    checkout.source.repositoryFingerprint,
  );
  await guest("test", "-f", tree.guestPath + "/kept.txt");

  const existing = await bind("git", {
    mode: "linux-existing",
    workspaceId: workspace.id,
    sourceKind: "git",
    relativePath,
    operationId: randomUUID(),
  });
  const adopted = await provision(existing, {
    kind: "existing",
    sourceKind: "git",
  });
  assert.equal(adopted.source.guestPath, seed);
  assert.equal(adopted.source.branch, "fixture");
  assert.notEqual(
    adopted.source.repositoryFingerprint,
    checkout.source.repositoryFingerprint,
  );
  assert.ok(adopted.record.processes.every((p) => p.argv[0] === "git"));
  assert.equal(
    (await call("POST", route(existing) + "/verify")).state,
    "ready",
  );

  await restartWorker();
  assert.deepEqual(
    await call("POST", route(managed) + "/recover"),
    checkout.outcome,
  );
  assert.deepEqual(
    await call("POST", route(tree) + "/recover"),
    linked.outcome,
  );
  assert.deepEqual(
    await call("POST", route(managed) + "/provision", checkout.input),
    checkout.outcome,
  );
  assert.equal(
    await guest("git", "-C", managed.guestPath, "rev-parse", "HEAD"),
    revision,
  );
  console.log(
    "Native Cantrip OS source smoke passed: folder, atomic conflict, Git, worktree, existing source and restart recovery.",
  );
  if (runDefinitions) {
    const { verifyRunDefinitions } =
      await import("./cantrip-os-run-definition-cases.mjs");
    await verifyRunDefinitions({
      call,
      route: route(managed),
      binding: managed,
      os,
      actual,
      data,
      workerId,
      serverId,
      hash,
      docker,
      container,
      stopWorker,
      restartWorker,
    });
  }
  if (!linkedFixture) return;

  // Materialize a real Host project through the existing public APIs. Use its
  // returned routing token in both the server placement and encrypted intent.
  const hostWorkspace = randomUUID();
  const project = randomUUID();
  await call(
    "POST",
    "/api/workspaces",
    {
      id: hostWorkspace,
      storage: { kind: "managed" },
      nameProtection: {
        state: "encrypted",
        ...projectLabel.protectedLabel,
        blindIndex: randomBytes(32).toString("base64url"),
      },
    },
    201,
  );
  await call(
    "POST",
    "/api/projects/from-folder",
    {
      id: project,
      workerId,
      workspaceId: hostWorkspace,
      nameProtection: projectLabel,
    },
    202,
  );
  await eventually(async () => {
    const setup = await call("GET", `/api/projects/${project}/folder-setup`);
    assert.equal(setup.state, "succeeded", JSON.stringify(setup));
  });
  const trees = await call("GET", `/api/projects/${project}/worktrees`);
  const primary = trees.find((tree) => tree.isPrimary);
  assert.match(primary.path, /^ctrr_[\w-]{43}$/u);
  const host = path.join(data, "workspaces", hostWorkspace, "folders", project);
  await chmod(host, 0o777);
  await mkdir(path.join(host, "node_modules"));
  await writeFile(path.join(host, "README.md"), "original Host content");
  await writeFile(path.join(host, "node_modules", "marker"), "Host dependency");
  await docker(
    "exec",
    "--user",
    "0",
    container,
    "touch",
    "/etc/cantrip-fixture-system",
  );
  const dependencyOverlays = [{ path: "node_modules" }];
  const binding = await call("POST", bindings(project), {
    mode: "linked",
    workspaceId: workspace.id,
    worktreeId: primary.id,
    dependencyOverlays,
  });
  const cacheKey = `${binding.projectSourceId}:${binding.worktreeId}:${binding.workspaceId}`;
  linkedFixture.volumes.push(
    "cantrip-os-deps-" +
      hash([os.guestInstanceId, cacheKey, "node_modules"]).slice(0, 40),
  );
  let journalFile;
  const mounted = await submit(
    binding,
    {
      mode: "linked",
      workerPath: primary.path,
      dependencyOverlays,
    },
    (operation, journal) => {
      journalFile = journal + ".docker";
      linkedFixture.journals.push(journalFile);
      linkedFixture.operations.push(operation);
    },
  );
  assert.equal(mounted.outcome.state, "ready", mounted.record.error ?? "");
  const source = mounted.outcome.receipt.source;
  assert.equal(source.recreated, true);
  assert.notEqual(source.runtimeGeneration, os.runtimeGeneration);
  assert.deepEqual(source.dependencyOverlays, dependencyOverlays);
  assert.deepEqual(source.cleanupWarnings, []);
  const dockerJournal = JSON.parse(await readFile(journalFile, "utf8"));
  assert.equal(dockerJournal.phase, "complete");
  assert.equal(dockerJournal.original.Id, container);
  const sidecar = JSON.parse(await readFile(journalFile + ".binding", "utf8"));
  assert.equal(sidecar.state, "succeeded");
  assert.equal(sidecar.receipt.workspaceId, actual.id);
  assert.equal(dockerJournal.bindings[0].cacheKey, cacheKey);
  assert.equal(
    mounted.record.admissionFingerprint,
    hash([
      "cantrip-os.source.provision",
      {
        mode: "linked",
        workerPath: dockerJournal.bindings[0].workerPath,
        dependencyOverlays,
      },
    ]),
  );
  const candidate = dockerJournal.candidateId;
  const inReplacement = (...args) =>
    docker("exec", "--user", String(actual.uid), candidate, ...args);
  await assert.rejects(docker("inspect", container), /No such object/u);
  assert.equal(
    await inReplacement("cat", source.guestPath + "/README.md"),
    "original Host content",
  );
  await inReplacement("test", "-f", "/etc/cantrip-fixture-system");
  await inReplacement("test", "-f", managed.guestPath + "/kept.txt");
  await inReplacement("touch", source.guestPath + "/guest-write");
  await readFile(path.join(host, "guest-write"));
  await inReplacement(
    "test",
    "!",
    "-e",
    source.guestPath + "/node_modules/marker",
  );
  await inReplacement("touch", source.guestPath + "/node_modules/guest-only");
  assert.equal(
    await readFile(path.join(host, "node_modules", "marker"), "utf8"),
    "Host dependency",
  );
  assert.deepEqual(await readdir(path.join(host, "node_modules")), ["marker"]);
  assert.ok(
    (await readdir(host)).every(
      (name) => !name.startsWith(".cantrip-os-link-"),
    ),
  );
  assert.equal((await call("POST", route(binding) + "/verify")).state, "ready");
  await restartWorker();
  assert.deepEqual(
    await call("POST", route(binding) + "/recover"),
    mounted.outcome,
  );
  assert.deepEqual(
    await call("POST", route(binding) + "/provision", mounted.input),
    mounted.outcome,
  );
  assert.equal(
    await docker("inspect", "--format", "{{.Id}}", linkedFixture.name),
    candidate,
  );
  console.log(
    "Native Cantrip OS linked source smoke passed: replacement, retained state, live Host bytes, isolated dependencies and restart recovery.",
  );
}
