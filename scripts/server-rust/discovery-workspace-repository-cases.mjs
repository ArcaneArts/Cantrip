import assert from "node:assert/strict";
import { discoveryWireFixtures } from "./discovery-wire-fixtures.mjs";
import { literal } from "./project-target-state.mjs";
export async function discoveryWorkspaceCases({
  observe,
  seed,
  snapshot,
  unchanged,
  owner,
  workspace,
  handle,
  projectLabel,
}) {
  const managed = "55555555-5555-4555-8555-000000000001",
    attached = "55555555-5555-4555-8555-000000000002";
  const name = {
    ...discoveryWireFixtures(projectLabel)
      .encryptedProjectWorkspaceCreateSchema[0].nameProtection,
    blindIndex: Buffer.alloc(32, 3).toString("base64url"),
  };
  const create = (
    id = managed,
    storage = { kind: "managed" },
    nameProtection = name,
  ) => ({
    op: "discovery-workspace-create",
    owner,
    input: { id, storage, nameProtection },
  });
  const update = (id, input, account = owner) => ({
    op: "discovery-workspace-update",
    owner: account,
    workspace: id,
    input,
  });
  const list = () =>
    observe("list native workspace catalog", {
      op: "discovery-workspace-list",
      owner,
    });
  const initial = await list();
  assert.equal(initial[0].workspaces.filter((w) => w.isDefault).length, 1);
  assert.equal(
    initial[0].workspaces.find((w) => w.isDefault).nameProtection.state,
    "system-default",
  );
  await unchanged("workspace creation requires encryption profile", create());
  await unchanged(
    "unverified attachment cannot create a workspace",
    create(attached, {
      kind: "attached",
      workerId: "alpha",
      rootPathHandle: handle(150),
      displayHandle: handle(151),
    }),
  );
  await unchanged("verified attachment requires attached storage", {
    ...create(),
    op: "discovery-workspace-attach",
  });
  await seed(
    `INSERT INTO account_encryption_profiles(owner_id,format_version,active_master_key_revision) VALUES(${literal(owner)},1,1)`,
  );
  await unchanged(
    "workspace name uses active master key",
    create(managed, { kind: "managed" }, { ...name, keyRevision: 2 }),
  );
  const created = await observe("create managed encrypted workspace", create());
  assert.equal(created[0].id, managed);
  assert.equal(created[0].revision, 1);
  assert.equal(created[0].isDefault, false);
  assert.deepEqual(created[0].projectIds, []);
  const attachedRows = await observe("create verified attached workspace", {
    ...create(
      attached,
      {
        kind: "attached",
        workerId: "alpha",
        rootPathHandle: handle(150),
        displayHandle: handle(151),
      },
      {
        ...name,
        blindIndex: Buffer.alloc(32, 4).toString("base64url"),
      },
    ),
    op: "discovery-workspace-attach",
  });
  assert.equal(attachedRows[0].storage.rootPathHandle, handle(150));
  await unchanged(
    "attached workspace cannot become default",
    update(attached, { expectedRevision: 1, isDefault: true }),
  );
  await observe(
    "foreign owner cannot update workspace",
    update(managed, { expectedRevision: 1, isDefault: true }, "foreign"),
  );
  await observe(
    "missing workspace update",
    update("missing", { expectedRevision: 1, isDefault: true }),
  );
  await unchanged(
    "renamed workspace key must be active",
    update(managed, {
      expectedRevision: 1,
      nameProtection: { ...name, keyRevision: 2 },
    }),
  );
  const before = await list();
  await unchanged(
    "stale default promotion rolls back prior default update",
    update(managed, { expectedRevision: 99, isDefault: true }),
  );
  const after = await list();
  assert.deepEqual(after[0], before[0]);
  const promoted = await observe(
    "promote managed workspace to default",
    update(managed, { expectedRevision: 1, isDefault: true }),
  );
  assert.equal(promoted[0].isDefault, true);
  assert.equal(promoted[0].revision, 2);
  await unchanged("default workspace cannot be deleted", {
    op: "discovery-workspace-delete",
    owner,
    workspace: managed,
  });
  const current = await list();
  const system = current[0].workspaces.find((w) => w.storage.kind === "system");
  await unchanged("system workspace cannot be deleted when not default", {
    op: "discovery-workspace-delete",
    owner,
    workspace: system.id,
  });
  await observe(
    "restore system default",
    update(system.id, { expectedRevision: system.revision, isDefault: true }),
  );
  await observe(
    "rename encrypted workspace",
    update(managed, {
      expectedRevision: 3,
      nameProtection: {
        ...name,
        blindIndex: Buffer.alloc(32, 6).toString("base64url"),
      },
    }),
  );
  await observe("foreign deletion plan is absent", {
    op: "discovery-workspace-delete-plan",
    owner: "foreign",
    workspace: managed,
  });
  await observe("managed deletion plan", {
    op: "discovery-workspace-delete-plan",
    owner,
    workspace: managed,
  });
  await observe("delete managed workspace", {
    op: "discovery-workspace-delete",
    owner,
    workspace: managed,
  });
  await observe("delete attached workspace preserving root binding", {
    op: "discovery-workspace-delete",
    owner,
    workspace: attached,
  });
  await observe("missing workspace deletion is false", {
    op: "discovery-workspace-delete",
    owner,
    workspace: managed,
  });
  await snapshot("workspace catalog and default revisions");
  assert.equal(
    (await list())[0].workspaces.find((w) => w.id === workspace).storage
      .workerId,
    "alpha",
  );
}
