import assert from "node:assert/strict";
import { workspaceState, workspaceTab } from "./workspace-wire-fixtures.mjs";
import {
  label,
  state,
  literal,
  json,
  stamp,
  localOwner,
} from "./project-target-state.mjs";

export async function workspaceAuthorityRepositoryCases({
  observe,
  seed,
  snapshot,
}) {
  let sequence = 0;
  const documents = Array.from(
    { length: 11 },
    (_, i) => `eeeeeeee-eeee-4eee-8eee-${String(100 + i).padStart(12, "0")}`,
  );
  const document = async (
    id,
    project = "github",
    worker = "alpha",
    tree = "github-alpha-main",
  ) =>
    seed(
      `INSERT INTO file_documents(id,project_id,worker_id,worktree_id,protected_state,created_at) VALUES(${literal(id)},${literal(project)},${literal(worker)},${literal(tree)},${json(state("file-document-state"))},${literal(stamp)})`,
    );
  for (const id of documents) await document(id);
  await document("foreign-document", "other", "foreign", "other-foreign-main");
  async function fixture(
    workspace,
    definition = "project.terminal",
    resource = "terminal",
  ) {
    const layout = workspaceState(workspace, resource);
    layout.windows[0].panes[0].tabs[0] = workspaceTab(
      "a",
      resource,
      definition,
    );
    await seed(
      `INSERT INTO workspace_layouts(owner_id,project_id,workspace_id,layout) VALUES(${literal(localOwner)},'github',${literal(workspace)},${json(layout)})`,
    );
    return layout;
  }
  function command(workspace, action, revision = 4) {
    return {
      operationId: "authority-" + sequence++,
      projectId: "github",
      workspaceId: workspace,
      windowId: "main",
      attachmentGeneration: 1,
      expectedRevision: revision,
      action,
    };
  }
  const execute = (name, input, options = {}) =>
    observe(name, { op: "workspace-execute", input }, options);
  const codeAction = {
    type: "migrate-code-files",
    tabId: "a",
    codeId: "code",
    expectedWorkerId: "alpha",
    expectedWorktreeId: "github-alpha-main",
    views: documents.map((documentId, i) => ({
      tabId: "code-file-" + i,
      documentId,
      mode: i % 2 ? "visual" : "edit",
    })),
  };
  await fixture("code-migration", "project.code", "code");
  for (const [name, changes, code] of [
    ["missing legacy Code", { codeId: "missing" }, "missing"],
    ["foreign legacy Code", { codeId: "other-code" }, "missing"],
    ["changed legacy worker", { expectedWorkerId: "beta" }, "invalid"],
    [
      "changed legacy worktree",
      { expectedWorktreeId: "github-beta-main" },
      "invalid",
    ],
    [
      "missing migration document",
      { views: [{ tabId: "file", documentId: "missing", mode: "edit" }] },
      "missing",
    ],
    [
      "foreign migration document",
      {
        views: [
          { tabId: "file", documentId: "foreign-document", mode: "edit" },
        ],
      },
      "missing",
    ],
  ])
    await execute(
      name,
      command("code-migration", { ...codeAction, ...changes }),
      { rejected: true, code },
    );
  for (const [name, change, restore] of [
    [
      "unlinked document worker",
      "UPDATE workers SET unlinked_at=now() WHERE id='alpha'",
      "UPDATE workers SET unlinked_at=NULL WHERE id='alpha'",
    ],
    [
      "removed document source",
      "UPDATE project_sources SET removed_at=now() WHERE id='github-alpha'",
      "UPDATE project_sources SET removed_at=NULL WHERE id='github-alpha'",
    ],
    [
      "unready document checkout",
      "UPDATE project_worktrees SET lifecycle_state='creating' WHERE id='github-alpha-main'",
      "UPDATE project_worktrees SET lifecycle_state='ready' WHERE id='github-alpha-main'",
    ],
    [
      "document and checkout workers disagree",
      `UPDATE file_documents SET worker_id='beta' WHERE id=${literal(documents[0])}`,
      `UPDATE file_documents SET worker_id='alpha' WHERE id=${literal(documents[0])}`,
    ],
  ]) {
    await seed(change);
    try {
      await execute(name, command("code-migration", codeAction), {
        rejected: true,
        code: "missing",
      });
    } finally {
      await seed(restore);
    }
  }
  const codeCommand = command("code-migration", codeAction);
  const converted = await execute(
    "eleven immutable Code views use exact dynamic SQL bindings",
    codeCommand,
  );
  assert.equal(converted.layout.revision, 5);
  assert.equal(
    converted.layout.windows[0].panes[0].tabs.filter(
      (t) => t.resource.definitionId === "project.file",
    ).length,
    11,
  );
  await seed(
    "UPDATE code_tabs SET active_worker_id='beta',worktree_id='github-beta-main' WHERE id='code'",
  );
  await execute(
    "Code command receipt replays before changed source validation",
    codeCommand,
  );
  await execute(
    "new Code command still validates current source",
    command("code-migration", codeAction, 5),
    { rejected: true, code: "invalid" },
  );
  await seed(
    "UPDATE code_tabs SET active_worker_id='alpha',worktree_id='github-alpha-main' WHERE id='code'",
  );

  await fixture("explorer-migration", "project.explorer", "explorer");
  const explorerAction = {
    type: "migrate-explorer-file",
    tabId: "a",
    explorerId: "explorer",
    expectedWorkerId: "alpha",
    expectedWorktreeId: "github-alpha-main",
    expectedStateProtection: state("explorer-state"),
    documentId: documents[0],
    mode: "edit",
    retainedViews: [
      { tabId: "retained-file", documentId: documents[1], mode: "visual" },
    ],
  };
  const changedState = structuredClone(state("explorer-state"));
  changedState.protectedState.envelope.ciphertext =
    "B" + changedState.protectedState.envelope.ciphertext.slice(1);
  await execute(
    "Explorer protected snapshot must match exactly",
    command("explorer-migration", {
      ...explorerAction,
      expectedStateProtection: changedState,
    }),
    { rejected: true, code: "invalid" },
  );
  await seed(
    `UPDATE file_documents SET worker_id='beta',worktree_id='github-beta-main' WHERE id=${literal(documents[0])}`,
  );
  await execute(
    "selected Explorer document must match its legacy checkout",
    command("explorer-migration", explorerAction),
    { rejected: true, code: "invalid" },
  );
  await seed(
    `UPDATE file_documents SET worker_id='alpha',worktree_id='github-alpha-main' WHERE id=${literal(documents[0])}`,
  );
  await seed(
    `UPDATE file_documents SET worker_id='beta',worktree_id='github-beta-main' WHERE id=${literal(documents[1])}`,
  );
  const explorerCommand = command("explorer-migration", explorerAction);
  const explorer = await execute(
    "Explorer converts selection and retains another owned checkout",
    explorerCommand,
  );
  assert.equal(explorer.layout.revision, 5);
  await seed(
    `UPDATE explorers SET protected_state=${json(changedState)} WHERE id='explorer'`,
  );
  await execute(
    "Explorer command receipt survives a changed protected snapshot",
    explorerCommand,
  );
  await seed(
    `UPDATE explorers SET protected_state=${json(state("explorer-state"))} WHERE id='explorer'`,
  );

  await fixture("open-authority", "project.terminal", "existing-terminal");
  let revision = 4;
  for (const [definitionId, resourceId, record] of [
    ["project.agent", "chat", "chat"],
    ["project.terminal", "terminal", "terminal"],
    ["project.explorer", "explorer", "explorer"],
    ["project.browser", "browser", "browser"],
    ["project.code", "code", "code-tab"],
    ["project.remote-desktop", "desktop", "project-view"],
    ["project.file", documents[0], null],
  ]) {
    const tab = workspaceTab("opened-" + sequence, resourceId, definitionId);
    if (definitionId === "project.file") tab.fileMode = "edit";
    const result = await execute(
      "canonical resource authority: " + definitionId,
      command(
        "open-authority",
        { type: "open", tab, target: { kind: "pane", paneId: "center-a" } },
        revision,
      ),
    );
    revision = result.layout.revision;
    const actual = result.layout.windows
      .flatMap((w) => w.panes.flatMap((p) => p.tabs))
      .find(
        (t) =>
          t.resource.definitionId === definitionId &&
          t.resource.resourceId === resourceId,
      );
    assert.deepEqual(actual.titleProtection, record ? label(record) : null);
  }
  await execute(
    "foreign surface is unavailable",
    command(
      "open-authority",
      {
        type: "open",
        tab: workspaceTab("foreign", "other-terminal"),
        target: { kind: "pane", paneId: "center-a" },
      },
      revision,
    ),
    { rejected: true, code: "missing" },
  );
  const builtin = {
    id: "history",
    resource: { kind: "builtin", definitionId: "git.history" },
    preview: false,
    titleProtection: null,
    builtInState: {
      definitionId: "git.history",
      worktreeId: "other-foreign-main",
    },
    dockPresentation: null,
  };
  await execute(
    "builtin cannot bind a foreign checkout",
    command(
      "open-authority",
      {
        type: "open",
        tab: builtin,
        target: { kind: "pane", paneId: "center-a" },
      },
      revision,
    ),
    { rejected: true, code: "missing" },
  );
  const before = await observe("read before injected receipt failure", {
    op: "workspace-get",
    workspace: "open-authority",
  });
  await seed(
    "CREATE FUNCTION workspace_receipt_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation_id='reject-receipt' THEN RAISE EXCEPTION 'controlled workspace receipt failure'; END IF; RETURN NEW; END $$",
  );
  await seed(
    "CREATE TRIGGER workspace_receipt_reject BEFORE INSERT ON workspace_command_receipts FOR EACH ROW EXECUTE FUNCTION workspace_receipt_reject()",
  );
  const rejected = {
    ...command("open-authority", { type: "home" }, revision),
    operationId: "reject-receipt",
  };
  try {
    await execute(
      "receipt insertion failure rolls back the layout mutation",
      rejected,
      { rejected: true },
    );
    await observe(
      "failed receipt retains original authoritative layout",
      { op: "workspace-get", workspace: "open-authority" },
      { expected: before },
    );
  } finally {
    await seed(
      "DROP TRIGGER workspace_receipt_reject ON workspace_command_receipts",
    );
    await seed("DROP FUNCTION workspace_receipt_reject()");
  }
  const retried = await execute(
    "same identity succeeds after real receipt failure is removed",
    rejected,
  );
  assert.equal(retried.replayed, false);
  assert.equal(retried.layout.revision, revision + 1);
  await snapshot("document migrations and atomic receipt persistence");
}
