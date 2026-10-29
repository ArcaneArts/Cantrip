// Execute failures inside real cleanup transactions and compare the source SQL.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { terminalDeletionFixture } from "./terminal-deletion-fixture.mjs";

const { queries } = JSON.parse(
  await readFile(
    new URL(
      "../../cantrip_server_rs/src/database/resource_layout_queries.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

export async function terminalLayoutFailures({
  seed,
  observe,
  snapshot,
  rollback,
  owner,
  report,
}) {
  const { clean, prepare } = terminalDeletionFixture({ seed, owner });
  const fail = async (name, key) => {
    await observe(
      name,
      { op: "terminal-delete", terminal: "sql-terminal" },
      true,
      { diagnostic: true },
    );
    for (const value of report.cases.at(-1).values)
      assert.ok(
        value.diagnostic.startsWith(
          "Failed query: " + queries[key] + "\nparams: ",
        ),
        name + " identifies the actual source statement",
      );
  };
  const scenarios = [
    [
      "workspace write",
      "workspace_update",
      "workspace_layouts",
      "UPDATE",
      "NEW.workspace_id='sql-workspace'",
      {},
    ],
    [
      "membership delete",
      "member_delete",
      "tab_group_members",
      "DELETE",
      "OLD.tab_id='sql-terminal'",
      {},
    ],
    [
      "anchor update",
      "group_anchor",
      "tab_groups",
      "UPDATE",
      "OLD.id='sql-pane'",
      {},
    ],
    [
      "anchor and label update",
      "group_anchor_label",
      "tab_groups",
      "UPDATE",
      "OLD.id='sql-pane'",
      { remaining: 1 },
    ],
    [
      "label update",
      "group_label",
      "tab_groups",
      "UPDATE",
      "OLD.id='sql-pane'",
      { remaining: 1, anchor: false },
    ],
    [
      "membership compaction",
      "member_position",
      "tab_group_members",
      "UPDATE",
      "OLD.tab_id='sql-retained-one'",
      {},
    ],
    [
      "pane delete",
      "group_delete",
      "tab_groups",
      "DELETE",
      "OLD.id='sql-pane'",
      { remaining: 0 },
    ],
    [
      "dock compaction",
      "group_position",
      "tab_groups",
      "UPDATE",
      "OLD.id='sql-other'",
      { remaining: 0 },
    ],
    [
      "center write",
      "center_update",
      "projects",
      "UPDATE",
      "OLD.id='github' AND OLD.center_layout_root IS DISTINCT FROM NEW.center_layout_root",
      { remaining: 0, center: true },
    ],
    [
      "center compaction",
      "group_position",
      "tab_groups",
      "UPDATE",
      "OLD.id='sql-other'",
      { remaining: 0, center: true },
    ],
    [
      "project revision",
      "project_revision",
      "projects",
      "UPDATE",
      "OLD.id='github' AND OLD.tab_layout_revision<>NEW.tab_layout_revision",
      {},
    ],
  ];
  for (const [name, key, table, event, condition, shape] of scenarios) {
    await prepare(shape);
    await seed(
      "CREATE FUNCTION layout_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intentional layout fixture failure'; END $$",
    );
    try {
      await seed(
        `CREATE TRIGGER layout_fixture_failure BEFORE ${event} ON ${table} FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION layout_fixture_failure()`,
      );
      await rollback(name, () =>
        fail(name + " failure preserves SQL diagnostics", key),
      );
    } finally {
      await seed(`DROP TRIGGER IF EXISTS layout_fixture_failure ON ${table}`);
      await seed("DROP FUNCTION layout_fixture_failure()");
    }
  }
  for (const [table, column, key, shape] of [
    ["workspace_layouts", "layout", "workspace_rows", {}],
    ["tab_groups", "anchor_tab_key", "member_select", {}],
    ["tab_group_members", "position", "member_select", {}],
    [
      "projects",
      "center_layout_root",
      "center_read",
      { remaining: 0, center: true },
    ],
  ]) {
    await prepare(shape);
    const name = `missing ${table}.${column}`,
      before = await snapshot(name + " before");
    await seed(
      `ALTER TABLE ${table} RENAME COLUMN ${column} TO fixture_missing_column`,
    );
    try {
      await fail(name + " actual query failure", key);
    } finally {
      await seed(
        `ALTER TABLE ${table} RENAME COLUMN fixture_missing_column TO ${column}`,
      );
    }
    const after = await snapshot(name + " after");
    assert.deepEqual(after, before, name + " exact transaction rollback");
  }
  await prepare({ remaining: 0, center: true });
  await seed(
    "UPDATE projects SET center_layout_root='null'::jsonb WHERE id='github'",
  );
  await rollback("legacy JSON null center root", () =>
    observe(
      "JSON null uses source missing-root error",
      { op: "terminal-delete", terminal: "sql-terminal" },
      true,
      { diagnostic: true },
    ),
  );
  await clean();
}
