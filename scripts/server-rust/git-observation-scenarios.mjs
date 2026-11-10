import assert from "node:assert/strict";
import {
  completed,
  context,
  observation,
  operationId as id,
  worktreePath,
  sourcePath,
} from "./git-observation-fixtures.mjs";
import {
  settingsProject as project,
  settingsTree as tree,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import { literal, json, stamp } from "./project-target-state.mjs";
import { eventually } from "./full-worker.mjs";

const resources = [
  "worktree-status",
  "worktree",
  "git-operation",
  "git-conflict",
];
const terminalEvents = [
  "worktree-status",
  "worktree",
  "git-operation",
  "git-conflict",
  "worktree",
  "worktree",
];
const warning = "Could not reconcile observed Git operation state";
const count = (s, needle) => s.split(needle).length - 1;

export async function gitObservationScenarios(
  h,
  result,
  read,
  setInspector,
  executeSql,
) {
  let counter = 0;
  result.actions ??= [];
  const at = () => new Date(Date.parse(stamp) + ++counter * 1000).toISOString();
  const nextState = () => {
    const head = (++counter).toString(16).padStart(40, "0");
    return {
      ...completed,
      currentHead: head,
      output: "observed-" + counter,
      status: { ...completed.status, head },
    };
  };
  const notify = (
    state,
    conflicts = { files: [], truncated: false },
    changes = {},
  ) => observation(state, conflicts, { observedAt: at(), ...changes });
  const events = (from) =>
    h.live.history
      .slice(from)
      .filter((e) => e.type === "event" && resources.includes(e.resource));
  const reset = () =>
    executeSql([
      `UPDATE git_operations SET state='running',current_head=${literal(context.originalHead)},pending_commits=${json(context.pendingCommits)},current_step=0,total_steps=1,conflicted_paths='[]',output='before',paused_action=NULL,error='previous failure',completed_at=NULL,updated_at=${literal(stamp)} WHERE id=${literal(id)}`,
      `UPDATE project_worktrees SET branch='before',head=${literal(context.originalHead)},detached=false,lifecycle_state='ready',locked=false,lock_reason=NULL,status_snapshot=NULL,updated_at=${literal(stamp)},last_scanned_at=NULL,status_observed_at=NULL WHERE id=${literal(tree)}`,
    ]);
  async function send(
    name,
    notifications,
    {
      reply = completed,
      expected = terminalEvents,
      inspect = 1,
      failed = false,
      check = () => {},
    } = {},
  ) {
    const action = {
      name,
      before: await read(),
      notifications,
      startedAt: Date.now(),
    };
    result.actions.push(action);
    const from = h.live.history.length,
      commandStart = result.commands.length,
      warnings = count(h.diagnostics(), warning);
    setInspector(async () => reply);
    for (const notification of notifications)
      assert.equal(h.worker.sendNotification(notification), true);
    if (failed)
      await eventually(
        () => h.diagnostics(),
        (s) => assert.ok(count(s, warning) > warnings),
      );
    else
      await eventually(
        () => events(from),
        (e) =>
          assert.deepEqual(
            e.map((x) => x.resource),
            expected,
            name,
          ),
      );
    await h.live.ping(name);
    action.events = events(from);
    action.after = await read();
    action.commands = result.commands.slice(commandStart);
    action.finishedAt = Date.now();
    assert.deepEqual(
      action.events.map((x) => x.resource),
      failed ? [] : expected,
      name,
    );
    assert.equal(action.commands.length, inspect, name + " inspect count");
    check(action);
    return action;
  }

  // A changed terminal conflict observation is an actual processing boundary
  // behind the repeated fingerprint, so duplicate suppression isn't timed.
  const initial = observation();
  const barrier = notify(completed, { files: [], truncated: true });
  await send("settled fingerprint replay", [initial, barrier], {
    expected: ["git-conflict", "worktree"],
    inspect: 0,
    check: (a) => {
      assert.deepEqual(a.after, a.before);
      assert.equal(a.events[0].payload.truncated, true);
    },
  });
  const stale = observation(
    { ...completed, currentStep: 2 },
    { files: [], truncated: false },
    { observedAt: "2026-10-24T00:00:00.000Z" },
  );
  const next = notify({ ...completed, currentStep: 3 });
  await send("older observation is discarded", [stale, next], {
    expected: ["git-conflict", "worktree"],
    inspect: 0,
    check: (a) => assert.deepEqual(a.after, a.before),
  });
  await send(
    "terminal state cannot regress",
    [notify({ ...completed, state: "failed" })],
    {
      expected: ["worktree"],
      inspect: 0,
      check: (a) => assert.deepEqual(a.after, a.before),
    },
  );

  for (const changes of [
    { sourcePath: "ctrr_" + "t".repeat(43) },
    { worktreePath: "ctrr_" + "t".repeat(43) },
    { operationId: "88888888-8888-4888-8888-888888888888" },
  ]) {
    await reset();
    await send(
      "owned path/operation fence " + Object.keys(changes)[0],
      [notify(nextState(), undefined, changes)],
      {
        expected: ["worktree"],
        inspect: 0,
        check: (a) => assert.deepEqual(a.after, a.before),
      },
    );
  }

  await executeSql([
    `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES('git-observation-other-worker',${literal(h.owner)},'Other Git worker','linux','x64',${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO project_sources(id,project_id,worker_id,source_kind,absolute_path,display_path) VALUES('git-other-source',${literal(project)},'git-observation-other-worker','git','ctrr_${"t".repeat(43)}','ctrr_${"t".repeat(43)}')`,
    `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES('77777777-7777-4777-8777-777777777777','git-other-source','git-observation-other-worker','other','ctrr_${"v".repeat(43)}','ctrr_${"v".repeat(43)}',true,'cantrip','ready')`,
  ]);
  await reset();
  await send(
    "other worker's valid worktree context",
    [
      notify(nextState(), undefined, {
        worktreeId: "77777777-7777-4777-8777-777777777777",
        sourcePath: "ctrr_" + "t".repeat(43),
        worktreePath: "ctrr_" + "v".repeat(43),
      }),
    ],
    {
      expected: ["worktree"],
      inspect: 0,
      check: (a) => assert.deepEqual(a.after, a.before),
    },
  );
  for (const [name, change, restore] of [
    [
      "durable worker fence",
      `UPDATE git_operations SET worker_id='git-observation-other-worker' WHERE id=${literal(id)}`,
      `UPDATE git_operations SET worker_id=${literal(worker)} WHERE id=${literal(id)}`,
    ],
    [
      "missing worktree fence",
      `UPDATE project_worktrees SET lifecycle_state='missing' WHERE id=${literal(tree)}`,
      `UPDATE project_worktrees SET lifecycle_state='ready' WHERE id=${literal(tree)}`,
    ],
    [
      "removed source fence",
      `UPDATE project_sources SET removed_at=${literal(stamp)} WHERE id='settings-source'`,
      "UPDATE project_sources SET removed_at=NULL WHERE id='settings-source'",
    ],
  ]) {
    await reset();
    await executeSql([change]);
    try {
      await send(name, [notify(nextState())], {
        expected: ["worktree"],
        inspect: 0,
        check: (a) => assert.deepEqual(a.after, a.before),
      });
    } finally {
      await executeSql([restore]);
    }
  }

  await reset();
  const paused = {
    ...nextState(),
    state: "awaiting-user-action",
    pausedAction: "edit",
    conflictedPaths: ["src/冲突.rs"],
  };
  const conflicts = {
    files: [
      {
        path: "src/冲突.rs",
        code: "UU",
        kind: "both-modified",
        baseAvailable: true,
        oursAvailable: true,
        theirsAvailable: true,
      },
    ],
    truncated: false,
  };
  await send(
    "persist interactive pause and exact conflicts",
    [notify(paused, conflicts)],
    {
      reply: paused,
      expected: [
        "worktree-status",
        "worktree",
        "git-operation",
        "git-conflict",
        "worktree",
      ],
      check: (a) => {
        assert.equal(a.after.operation.paused_action, "edit");
        assert.equal(a.after.operation.completed_at, null);
        assert.equal(a.after.operation.error, null);
        assert.deepEqual(
          a.events.find((e) => e.resource === "git-conflict").payload,
          conflicts,
        );
      },
    },
  );

  await reset();
  const large = { ...nextState(), output: "x".repeat(300001) };
  await send(
    "persist large output and invalidate oversized publication",
    [notify(large)],
    {
      reply: large,
      check: (a) => {
        assert.equal(a.after.operation.output, "before\n" + large.output);
        assert.equal(
          a.events.find((e) => e.resource === "git-operation").action,
          "invalidated",
        );
        assert.ok(
          h
            .diagnostics()
            .includes("Could not publish exact Git operation state"),
        );
      },
    },
  );

  await reset();
  const actual = nextState(),
    hint = { ...actual, currentHead: "e".repeat(40) };
  await send("fresh inspect supersedes stale hint", [notify(hint)], {
    reply: actual,
    check: (a) => {
      assert.equal(a.after.operation.current_head, actual.currentHead);
      assert.equal(
        a.events.find((e) => e.resource === "git-conflict").action,
        "invalidated",
      );
    },
  });

  for (const [name, invalid] of [
    ["invalid worker state", { ...nextState(), currentStep: -1 }],
    [
      "immutable worker context",
      { ...nextState(), originalHead: "f".repeat(40) },
    ],
  ]) {
    await reset();
    const notification = notify(nextState());
    await send(name, [notification], {
      reply: invalid,
      failed: true,
      check: (a) => assert.deepEqual(a.after, a.before),
    });
    await send(name + " exact notification remains retryable", [notification], {
      reply: actual,
      check: (a) => assert.equal(a.after.operation.state, "completed"),
    });
  }

  await reset();
  const sqlState = nextState(),
    sqlNotification = notify(sqlState);
  await executeSql([
    "ALTER TABLE git_operations ADD CONSTRAINT git_observation_test_failure CHECK(state <> 'completed') NOT VALID",
  ]);
  try {
    await send("actual durable UPDATE failure", [sqlNotification], {
      reply: sqlState,
      failed: true,
      check: (a) => assert.deepEqual(a.after, a.before),
    });
  } finally {
    await executeSql([
      "ALTER TABLE git_operations DROP CONSTRAINT git_observation_test_failure",
    ]);
  }
  await send("same notification after SQL recovery", [sqlNotification], {
    reply: sqlState,
  });

  await reset();
  const statusState = nextState(),
    statusNotification = notify(statusState);
  await executeSql([
    `ALTER TABLE project_worktrees ADD CONSTRAINT git_status_test_failure CHECK(head=${literal(context.originalHead)}) NOT VALID`,
  ]);
  try {
    await send("status UPDATE failure after Git commit", [statusNotification], {
      reply: statusState,
      failed: true,
      check: (a) => {
        assert.equal(a.after.operation.state, "completed");
        assert.equal(a.after.operation.output, "before\n" + statusState.output);
        assert.deepEqual(a.after.worktree, a.before.worktree);
      },
    });
  } finally {
    await executeSql([
      "ALTER TABLE project_worktrees DROP CONSTRAINT git_status_test_failure",
    ]);
  }
  await send("terminal retry retains committed state", [statusNotification], {
    expected: ["git-conflict", "worktree"],
    inspect: 0,
    check: (a) => assert.deepEqual(a.after, a.before),
  });

  // Hold the actual worker response while later observations arrive. A status
  // notification on that same worker socket proves those packets were handled
  // before release, independently of timers and the Git project gate.
  await reset();
  const final = nextState(),
    started = notify({ ...final, state: "running", currentStep: 0 }),
    latest = notify(final, { files: [], truncated: true });
  const older = notify({ ...final, currentHead: "d".repeat(40) }, undefined, {
    observedAt: started.observedAt,
  });
  const action = {
    name: "coalesce pending observations while inspect is held",
    before: await read(),
    notifications: [started, latest, older],
    startedAt: Date.now(),
  };
  result.actions.push(action);
  let release,
    entered = false;
  const held = new Promise((resolve) => (release = resolve));
  setInspector(async () => {
    entered = true;
    await held;
    return final;
  });
  const from = h.live.history.length,
    commandStart = result.commands.length;
  try {
    assert.equal(h.worker.sendNotification(started), true);
    await eventually(
      () => entered,
      (value) => assert.equal(value, true),
    );
    assert.equal(h.worker.sendNotification(latest), true);
    assert.equal(h.worker.sendNotification(older), true);
    const status = {
      worktree: {
        path: worktreePath,
        head: context.originalHead,
        branch: "queued-marker",
        detached: false,
        isPrimary: true,
        managed: false,
        locked: false,
        lockReason: null,
        prunable: false,
        pruneReason: null,
        missing: false,
      },
      status: {
        ...completed.status,
        branch: "queued-marker",
        head: context.originalHead,
      },
    };
    assert.equal(
      h.worker.sendNotification({
        type: "worktree.status.observed",
        projectId: project,
        worktreeId: tree,
        sourcePath,
        worktreePath,
        result: status,
      }),
      true,
    );
    await eventually(read, (row) =>
      assert.equal(
        row.worktree.status_snapshot?.status.branch,
        "queued-marker",
      ),
    );
    await eventually(
      () => events(from),
      (e) =>
        assert.deepEqual(
          e.map((x) => x.resource),
          ["worktree-status", "worktree"],
        ),
    );
    action.marker = await read();
    release();
    await eventually(
      () => events(from),
      (e) =>
        assert.deepEqual(
          e.map((x) => x.resource),
          [
            "worktree-status",
            "worktree",
            ...terminalEvents,
            "git-conflict",
            "worktree",
          ],
        ),
    );
    await h.live.ping("coalesced drain");
    action.events = events(from);
    action.after = await read();
    action.commands = result.commands.slice(commandStart);
    action.finishedAt = Date.now();
    assert.equal(action.commands.length, 1);
    assert.equal(action.after.operation.output, "before\n" + final.output);
    assert.equal(
      action.events.filter((e) => e.resource === "git-conflict")[0].action,
      "invalidated",
    );
    assert.deepEqual(
      action.events.filter((e) => e.resource === "git-conflict")[1].payload,
      { files: [], truncated: true },
    );
  } finally {
    release();
  }
}

export function normalizeGitActions(peer) {
  const times = new Set([
    "created_at",
    "updated_at",
    "completed_at",
    "last_scanned_at",
    "status_observed_at",
    "createdAt",
    "updatedAt",
    "completedAt",
  ]);
  let revision = 0;
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([k]) => !["cursor", "occurredAt"].includes(k))
          .map(([key, v]) => {
            if (times.has(key) && v !== null)
              return [
                key,
                Date.parse(v) === Date.parse(stamp)
                  ? stamp
                  : "<verified observation clock>",
              ];
            if (key === "owner_id") return [key, "<authenticated owner>"];
            if (key === "revision" && v !== null) {
              assert.ok(Number.isSafeInteger(v) && v > revision);
              revision = v;
              return [key, "<monotonic Git revision>"];
            }
            return [key, normalize(v)];
          }),
      );
    return value;
  };
  for (const action of peer.actions) {
    assert.equal(action.before.operation.owner_id, peer.owner);
    assert.equal(action.after.operation.owner_id, peer.owner);
    for (const event of action.events) {
      if (event.revision !== null)
        assert.ok(
          event.revision >= action.startedAt * 1000 &&
            event.revision <= action.finishedAt * 1000 + 1000,
          action.name + " actual publication revision clock",
        );
      if (event.resource === "git-operation" && event.action === "updated") {
        for (const [key, column] of [
          ["createdAt", "created_at"],
          ["updatedAt", "updated_at"],
          ["completedAt", "completed_at"],
        ])
          assert.equal(
            event.payload.operation[key],
            action.after.operation[column] === null
              ? null
              : new Date(action.after.operation[column]).toISOString(),
            action.name + " publication SQL clock " + key,
          );
      }
    }
    for (const object of [action.after.operation, action.after.worktree]) {
      const before =
        object === action.after.operation
          ? action.before.operation
          : action.before.worktree;
      for (const key of times)
        if (
          object[key] !== undefined &&
          object[key] !== null &&
          object[key] !== before[key]
        )
          assert.ok(
            Date.parse(object[key]) >= action.startedAt &&
              Date.parse(object[key]) <= action.finishedAt,
            action.name + " real changed SQL clock " + key,
          );
    }
  }
  return peer.actions.map(({ name, before, after, events, commands }) => ({
    name,
    before: normalize(before),
    after: normalize(after),
    events: normalize(events),
    commands,
  }));
}
