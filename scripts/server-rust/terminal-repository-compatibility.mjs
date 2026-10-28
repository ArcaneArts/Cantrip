// Actual repository methods and complete durable layout snapshots on both runtimes.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import {
  targetStateSql,
  localOwner as owner,
  otherOwner as other,
  label,
  state,
  json,
  literal,
  stamp,
} from "./project-target-state.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report"),
  started = Date.now();
const root = await mkdtemp(path.join(tmpdir(), "cantrip-terminal-repository-"));
const report = {
  suite: "actual-terminal-resource-repositories",
  databaseMode,
  completeReplacement: false,
  cases: [],
  snapshots: [],
};
const ids = Array.from(
    { length: 40 },
    (_, i) => `55555555-5555-4555-8555-${String(i + 1).padStart(12, "0")}`,
  ),
  fixed = new Set([owner, other, ...ids]);
const aliases = [new Map(), new Map()],
  pair = [],
  urls = [];
let pg, executable, failure;
const open = (kind, i) =>
  repositoryFixture({
    kind,
    executable,
    root,
    databaseMode,
    databaseUrl: urls[i],
  });
const seed = async (sql) => {
  for (const repo of pair) await repo.seed(sql);
};
function normalize(value, i, key = "") {
  if (Array.isArray(value)) return value.map((v) => normalize(v, i));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalize(v, i, k)]),
    );
  if (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    ) &&
    !fixed.has(value)
  ) {
    if (!aliases[i].has(value))
      aliases[i].set(value, `<generated-layout-id:${aliases[i].size}>`);
    return aliases[i].get(value);
  }
  if (
    typeof value === "string" &&
    ["createdAt", "updatedAt", "created_at", "updated_at"].includes(key) &&
    value !== "infinity"
  ) {
    const millis = Date.parse(value);
    assert.ok(Number.isFinite(millis), "actual persisted timestamp must parse");
    if (millis === Date.parse(stamp)) return "<fixture-time>";
    assert.ok(
      millis >= started - 1000 && millis <= Date.now() + 1000,
      "generated timestamp belongs to this actual run",
    );
    return "<operation-time>";
  }
  return value;
}
async function observe(
  label,
  input,
  rejected = false,
  { diagnostic = false } = {},
) {
  const requests = [0, 1].map((i) => ({
    owner,
    project: "github",
    connected: ["alpha", "beta"],
    ...(typeof input === "function" ? input(i) : input),
  }));
  const values = await Promise.all(
    pair.map((repo, i) => repo.request(requests[i])),
  );
  report.cases.push({ label, requests, values });
  assert.equal(values[0].rejected, rejected, "Reference result: " + label);
  const ordered = (value) => {
    if (requests[0].op !== "terminal-list") return value;
    for (let i = 1; i < value.length; i++)
      assert.ok(
        value[i - 1].position < value[i].position ||
          (value[i - 1].position === value[i].position &&
            Date.parse(value[i - 1].createdAt) <=
              Date.parse(value[i].createdAt)),
        "actual list honors both declared ORDER BY keys",
      );
    // The two seeded terminals have exactly equal SQL sort keys. Reference
    // receipts show their order flipping after updates/reopen. Retain raw order
    // above and compare that known tie group without inventing a server order.
    return [...value].sort(
      (a, b) =>
        a.position - b.position ||
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        (Date.parse(a.createdAt) === Date.parse(stamp) &&
        Date.parse(b.createdAt) === Date.parse(stamp)
          ? a.id.localeCompare(b.id)
          : 0),
    );
  };
  const result = (v, i) =>
    v.rejected
      ? {
          rejected: true,
          ...(v.code ? { code: v.code } : {}),
          ...(diagnostic ? { diagnostic: v.diagnostic } : {}),
        }
      : { rejected: false, value: normalize(ordered(v.value), i) };
  assert.deepEqual(result(values[1], 1), result(values[0], 0), label);
  return values.map((v) => v.value);
}
const list = (label, extra = {}) =>
  observe(label, { op: "terminal-list", ...extra });
const context = (label, terminal = "terminal", extra = {}) =>
  observe(label, { op: "terminal-context", terminal, ...extra });
const create = (label, index, extra = {}, rejected = false, options = {}) =>
  observe(
    label,
    {
      op: "terminal-create",
      input: {
        id: ids[index],
        titleProtection: labelProtection,
        stateProtection: stateProtection,
        ...extra,
      },
    },
    rejected,
    options,
  );
const labelProtection = label("terminal"),
  stateProtection = state("terminal-state");
const snapshotSql = `SELECT jsonb_build_object(
 'terminals',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') FROM terminals t),
 'groups',(SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.region,g.position,g.id),'[]') FROM tab_groups g),
 'members',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.tab_key),'[]') FROM tab_group_members m),
 'project',(SELECT jsonb_build_object('id',id,'revision',tab_layout_revision,'root',center_layout_root,'updated_at',updated_at) FROM projects WHERE id='github')
) result`;
async function snapshot(label) {
  const replies = await Promise.all(
    pair.map((repo) => repo.request({ op: "query-json", sql: snapshotSql })),
  );
  for (const reply of replies) assert.equal(reply.rejected, false);
  const raw = replies.map((reply) => reply.value);
  report.snapshots.push({ label, raw });
  assert.deepEqual(normalize(raw[1], 1), normalize(raw[0], 0), label);
  return raw;
}
async function rollback(label, run) {
  const before = await snapshot(label + " before");
  await run();
  const after = await snapshot(label + " after");
  for (let i = 0; i < 2; i++)
    assert.deepEqual(
      after[i],
      before[i],
      label + " exact transaction rollback",
    );
}
try {
  executable = await buildRustExample("project-repository-fixture");
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const [i, kind] of ["node", "rust"].entries()) {
    urls[i] =
      pg && (kind === "node" || databaseMode === "postgres")
        ? await pg.database()
        : undefined;
    pair.push(await open(kind, i));
  }
  for (const sql of targetStateSql()) await seed(sql);
  await seed(
    `UPDATE user_settings SET workspace_layout_profile='hybrid' WHERE user_id=${literal(owner)}`,
  );
  assert.equal((await list("owned terminal list"))[0].length, 2);
  await list("foreign project is empty", { project: "other" });
  await list("missing project is empty", { project: "missing" });
  await context("owned execution context");
  await context("foreign owner cannot read context", "terminal", {
    owner: other,
  });
  await context(
    "actual foreign context belongs to its own owner",
    "other-terminal",
    { owner: other },
  );
  await seed(
    "UPDATE terminals SET active_worker_id='beta' WHERE id='terminal'",
  );
  assert.equal(
    (
      await context(
        "context uses active worker and bound worktree independently",
      )
    )[0].workerId,
    "beta",
  );
  await seed(
    "UPDATE terminals SET active_worker_id='alpha' WHERE id='terminal'",
  );
  await create("hybrid profile creates bottom pane", 0);
  let snap = await snapshot("new bottom membership and revision");
  assert.equal(snap[0].groups.length, 1);
  assert.equal(snap[0].groups[0].region, "bottom");
  assert.equal(snap[0].members.length, 1);
  await create("second bottom terminal reuses the dock pane", 1);
  snap = await snapshot("dock membership shares pane");
  assert.equal(snap[0].groups.length, 1);
  assert.equal(snap[0].members.length, 2);
  for (const index of [2, 3])
    await create("explicit center creates leaf " + index, index, {
      targetRegion: "center",
    });
  snap = await snapshot(
    "center topology includes every center pane exactly once",
  );
  assert.equal(snap[0].project.root.kind, "split");
  await seed(
    `UPDATE user_settings SET workspace_layout_profile='agent' WHERE user_id=${literal(owner)}`,
  );
  await create("agent profile creates another center pane", 4);
  await snapshot("agent default updates center topology");
  await seed(
    `UPDATE user_settings SET workspace_layout_profile='ide' WHERE user_id=${literal(owner)}`,
  );
  await create("IDE terminal default reuses bottom pane", 5);
  await seed(
    "INSERT INTO tab_groups(id,project_id,region,position,anchor_tab_key) VALUES ('fixed-right','github','right',0,'terminal:terminal')",
  );
  await create("explicit pane takes precedence over suggested region", 6, {
    paneId: "fixed-right",
  });
  await create("legacy pane spelling retains destination", 7, {
    tabGroupId: "fixed-right",
  });
  await snapshot("explicit pane memberships");
  await rollback("unsupported terminal region", () =>
    create("left placement rejected", 8, { targetRegion: "left" }, true, {
      diagnostic: true,
    }),
  );
  await rollback("missing destination pane", () =>
    create("unknown pane rejected", 8, { paneId: "missing-pane" }, true, {
      diagnostic: true,
    }),
  );
  await rollback("duplicate terminal identity", () =>
    create("duplicate insert rejects", 0, {}, true),
  );
  await observe(
    "foreign project creation denied",
    {
      op: "terminal-create",
      project: "other",
      input: { id: ids[8], titleProtection: labelProtection, stateProtection },
    },
    true,
  );
  await observe(
    "missing project creation denied",
    {
      op: "terminal-create",
      project: "missing",
      input: { id: ids[8], titleProtection: labelProtection, stateProtection },
    },
    true,
  );
  await observe("metadata update retains opaque label", {
    op: "terminal-update",
    terminal: ids[0],
    input: { titleProtection: labelProtection },
  });
  await observe("foreign metadata update hidden", {
    op: "terminal-update",
    owner: other,
    terminal: ids[0],
    input: { titleProtection: labelProtection },
  });
  await observe("service configuration persists opaque state", {
    op: "terminal-service",
    terminal: ids[0],
    input: { enabled: true, stateProtection },
  });
  await context("enabled service context", ids[0]);
  await snapshot("enabled state persists independently of status");
  await seed(
    "UPDATE terminals SET kind='chat-console',linked_chat_id='chat' WHERE id='terminal'",
  );
  await observe(
    "linked console cannot become a service",
    {
      op: "terminal-service",
      terminal: "terminal",
      input: { enabled: true, stateProtection },
    },
    true,
    { diagnostic: true },
  );
  await observe("linked console title can update", {
    op: "terminal-update",
    terminal: "terminal",
    input: { titleProtection: labelProtection },
  });
  await seed("UPDATE terminals SET position=2147483647 WHERE id='terminal'");
  await rollback("resource position overflow", () =>
    create("real integer INSERT rejects position overflow", 8, {}, true),
  );
  await seed("UPDATE terminals SET position=0 WHERE id='terminal'");
  await seed(
    `UPDATE tab_group_members SET position=2147483647 WHERE tab_id=${literal(ids[6])}`,
  );
  await rollback("pane member overflow", () =>
    create(
      "real member INSERT rejects position overflow",
      8,
      { paneId: "fixed-right" },
      true,
    ),
  );
  await seed(
    `UPDATE tab_group_members SET position=0 WHERE tab_id=${literal(ids[6])}`,
  );
  const prior = await snapshot("before malformed center topology");
  const pane = (paneId) => ({ kind: "pane", paneId });
  const split = (id, first, second) => ({
    kind: "split",
    id,
    direction: "horizontal",
    fraction: 0.5,
    first,
    second,
  });
  let balanced = Array.from({ length: 128 }, (_, i) =>
    pane("bounded-pane-" + i),
  );
  let splitIndex = 0;
  while (balanced.length > 1) {
    const next = [];
    for (let i = 0; i < balanced.length; i += 2)
      next.push(
        split("bounded-split-" + splitIndex++, balanced[i], balanced[i + 1]),
      );
    balanced = next;
  }
  for (const [name, node] of [
    [
      "duplicate center panes",
      split(
        "duplicate-pane-root",
        pane("repeated-pane"),
        pane("repeated-pane"),
      ),
    ],
    [
      "duplicate center split identifiers",
      split(
        "repeated-split",
        split("repeated-split", pane("a"), pane("b")),
        pane("c"),
      ),
    ],
    ["center pane set mismatch", pane("not-an-existing-pane")],
    ["center topology node count", balanced[0]],
  ]) {
    await seed(
      `UPDATE projects SET center_layout_root=${json(node)} WHERE id='github'`,
    );
    await rollback(name, () =>
      create(
        name + " rejects transaction",
        8,
        { targetRegion: "center" },
        true,
        { diagnostic: true },
      ),
    );
  }
  for (let i = 0; i < 2; i++) {
    let node = prior[i].project.root;
    for (let depth = 0; depth < 33; depth++)
      node = {
        kind: "split",
        id: "deep-" + depth,
        direction: "horizontal",
        fraction: 0.5,
        first: node,
        second: { kind: "pane", paneId: "unused-" + depth },
      };
    await pair[i].seed(
      `UPDATE projects SET center_layout_root=${json(node)} WHERE id='github'`,
    );
  }
  await rollback("center topology depth", () =>
    create(
      "center topology bound rejects transaction",
      8,
      { targetRegion: "center" },
      true,
      { diagnostic: true },
    ),
  );
  for (let i = 0; i < 2; i++)
    await pair[i].seed(
      `UPDATE projects SET center_layout_root=${json(prior[i].project.root)} WHERE id='github'`,
    );
  await seed(
    `UPDATE terminals SET created_at='infinity' WHERE id=${literal(ids[0])}`,
  );
  await observe(
    "invalid stored date remains an actual mapper failure",
    {
      op: "terminal-update",
      terminal: ids[0],
      input: { titleProtection: labelProtection },
    },
    true,
    { diagnostic: true },
  );
  await seed(
    `UPDATE terminals SET created_at=${literal(stamp)} WHERE id=${literal(ids[0])}`,
  );
  await snapshot("all prior resource and layout writes retained");
  for (const repo of pair) await repo.close();
  pair.length = 0;
  for (const [i, kind] of ["node", "rust"].entries())
    pair.push(await open(kind, i));
  await list("real process reopen retains terminal projection");
  await snapshot("real reopen retains complete terminal and pane state");
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  for (const repo of pair) await repo.close();
  await pg?.close();
  await rm(root, { recursive: true, force: true });
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    cases: report.cases.length,
    snapshots: report.snapshots.length,
  }),
);
