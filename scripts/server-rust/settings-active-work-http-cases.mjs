// Real migrated rows exercise each count's ownership and lifecycle predicates.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as schema from "../../tests/reference-node-server/src/db/schema.ts";
import { literal } from "./project-target-state.mjs";
import {
  settingsChat as chat,
  settingsProject as project,
  settingsTree as tree,
} from "./native-settings-http-fixture.mjs";
const require = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
);
const { getTableConfig } = require("drizzle-orm/pg-core");
const future = "2099-01-01T00:00:00.000Z";
function insert(table, values) {
  const config = getTableConfig(table),
    row = { ...values };
  for (const column of config.columns)
    if (
      column.notNull &&
      !column.hasDefault &&
      !Object.hasOwn(row, column.name)
    ) {
      row[column.name] =
        column.columnType === "PgJsonb"
          ? {}
          : column.columnType === "PgTimestamp"
            ? future
            : column.columnType === "PgInteger"
              ? 1
              : "count-fixture";
    }
  const encode = (v) =>
    v === null
      ? "NULL"
      : typeof v === "boolean"
        ? String(v)
        : typeof v === "number"
          ? String(v)
          : typeof v === "object"
            ? literal(JSON.stringify(v)) + "::jsonb"
            : literal(v);
  return `INSERT INTO "${config.name}" (${Object.keys(row)
    .map((k) => '"' + k + '"')
    .join(",")}) VALUES(${Object.values(row).map(encode).join(",")})`;
}
export async function runSettingsActiveWorkHttpCases(h, visit) {
  const owner = h.owner,
    worker = "count-offline-worker",
    foreign = "count-foreign-owner";
  const base = {
    activeChats: 0,
    queuedPrompts: 0,
    terminalServices: 0,
    backgroundJobs: 0,
  };
  const read = (name) => visit(name, "GET", "/api/desktop-update/active-work");
  await h.fixture.sql([
    insert(schema.users, {
      id: foreign,
      kind: "account",
      display_name: "Other counter owner",
      email: "count-foreign@example.invalid",
      normalized_email: "count-foreign@example.invalid",
    }),
    insert(schema.workers, {
      id: worker,
      owner_id: owner,
      name: "Offline counter worker",
      platform: "linux",
      architecture: "x64",
      started_at: future,
      last_seen_at: future,
    }),
    insert(schema.projects, {
      id: "count-foreign-project",
      owner_id: foreign,
      github_repository_blind_index: "count-foreign",
    }),
    insert(schema.chats, {
      id: "count-foreign-chat",
      owner_id: foreign,
      project_id: "count-foreign-project",
      active_worktree_id: tree,
      status: "running",
    }),
    insert(schema.chats, {
      id: "count-standalone-chat",
      owner_id: owner,
      project_id: null,
      context_kind: "standalone",
      active_worker_id: worker,
      active_scratch_root_id: "count-standalone-scratch",
      worktree_mode: null,
      status: "running",
    }),
    insert(schema.standaloneChatRoots, {
      id: "count-standalone-scratch",
      chat_id: "count-standalone-chat",
      owner_id: owner,
      worker_id: worker,
      status: "offline",
    }),
    insert(schema.queuedPrompts, {
      id: "count-prompt",
      chat_id: chat,
      model_id: "probe-generic",
      idempotency_key: "count-prompt",
      text: "Disposable counter fixture",
      frozen: true,
    }),
    insert(schema.terminals, {
      id: "count-terminal",
      project_id: project,
      active_worker_id: worker,
      worktree_id: tree,
      service_enabled: true,
      protected_label: {},
      protected_state: {},
      status: "closed",
    }),
    insert(schema.projectAutomations, {
      id: "count-automation",
      owner_id: owner,
      project_id: project,
      chat_id: chat,
      enabled: false,
    }),
  ]);
  assert.deepEqual(
    await read(
      "standalone/foreign chats excluded; closed service and prompt counted",
    ),
    { ...base, queuedPrompts: 1, terminalServices: 1 },
  );
  await h.fixture.sql([
    `UPDATE chats SET archived_at=now() WHERE id=${literal(chat)}`,
  ]);
  assert.deepEqual(
    await read("archived chat still contributes its buffered prompt"),
    { ...base, queuedPrompts: 1, terminalServices: 1 },
  );
  await h.fixture.sql([
    `UPDATE chats SET archived_at=NULL WHERE id=${literal(chat)}`,
    "DELETE FROM queued_prompts WHERE id='count-prompt'",
    "UPDATE terminals SET service_enabled=false WHERE id='count-terminal'",
  ]);
  const common = {
    owner_id: owner,
    project_id: project,
    worker_id: worker,
    chat_id: chat,
    worktree_id: tree,
  };
  const groups = [
    [
      "projectReplicaJobs",
      "state",
      ["queued", "running", "blocked"],
      {
        kind: "provision",
        progress: { stage: "queued" },
        available_at: future,
        lease_expires_at: future,
      },
      ["succeeded", "failed", "cancelled"],
    ],
    [
      "chatRelocationJobs",
      "state",
      [
        "queued",
        "waiting-for-idle",
        "validating",
        "preparing-replica",
        "transferring-attachments",
        "hydrating-runtime",
        "ready-to-commit",
        "blocked",
      ],
      {
        source_placement: {},
        target_placement: {},
        progress: { stage: "queued" },
        available_at: future,
        lease_expires_at: future,
      },
      ["succeeded", "failed", "cancelled"],
    ],
    [
      "chatImportJobs",
      "state",
      [
        "queued",
        "reading",
        "importing",
        "awaiting-hydration",
        "hydrating",
        "blocked",
      ],
      {
        source_kind: "codex",
        source_worker_id: worker,
        target_placement: {},
        progress: { stage: "queued" },
        available_at: future,
        lease_expires_at: future,
      },
      ["succeeded", "failed", "cancelled"],
    ],
    [
      "projectAutomationRuns",
      "status",
      ["dispatching", "started", "queued"],
      {
        automation_id: "count-automation",
        lease_expires_at: future,
        scheduled_for: future,
      },
      ["skipped", "failed"],
    ],
    [
      "gitOperations",
      "state",
      ["queued", "running", "conflicted", "awaiting-user-action"],
      { type: "merge" },
      ["completed", "failed", "cancelled"],
    ],
    [
      "runConfigurationRuntimes",
      "state",
      ["starting", "running", "stopping"],
      {
        configuration_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        requested_operation_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition_revision: "a".repeat(64),
      },
      ["idle", "restarting", "exited", "failed", "lost"],
    ],
  ];
  for (const [name, column, states, extra, excluded] of groups) {
    const config = getTableConfig(schema[name]),
      allowed = new Set(config.columns.map((c) => c.name));
    const values = Object.fromEntries(
      Object.entries({
        ...common,
        ...extra,
        id:
          name === "runConfigurationRuntimes"
            ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
            : "count-" + name,
        [column]: excluded[0],
      }).filter(([k]) => allowed.has(k)),
    );
    await h.fixture.sql([insert(schema[name], values)]);
    for (const state of [...states, ...excluded]) {
      await h.fixture.sql([
        `UPDATE "${config.name}" SET "${column}"=${literal(state)} WHERE id=${literal(values.id)}`,
      ]);
      assert.deepEqual(await read(name + " state " + state), {
        ...base,
        backgroundJobs: states.includes(state) ? 1 : 0,
      });
    }
    await h.fixture.sql([
      `UPDATE "${config.name}" SET "${column}"=${literal(states[0])},owner_id=${literal(foreign)} WHERE id=${literal(values.id)}`,
    ]);
    assert.deepEqual(await read(name + " foreign owner excluded"), base);
    await h.fixture.sql([
      `DELETE FROM "${config.name}" WHERE id=${literal(values.id)}`,
    ]);
  }
  // Every query really fails against a temporarily missing relation. No
  // synthetic readiness flag or metadata-only gate substitutes for execution.
  for (const table of [
    "chats",
    "queued_prompts",
    "terminals",
    "project_replica_jobs",
    "chat_relocation_jobs",
    "chat_import_jobs",
    "project_automation_runs",
    "git_operations",
    "run_configuration_runtimes",
  ]) {
    await h.fixture.sql([
      `ALTER TABLE "${table}" RENAME TO "count_fault_hidden"`,
    ]);
    try {
      await visit(
        "actual missing count relation " + table,
        "GET",
        "/api/desktop-update/active-work",
        { status: 500 },
      );
    } finally {
      await h.fixture.sql([
        `ALTER TABLE "count_fault_hidden" RENAME TO "${table}"`,
      ]);
    }
    assert.deepEqual(
      await read("count recovers after " + table + " restoration"),
      base,
    );
  }
}
