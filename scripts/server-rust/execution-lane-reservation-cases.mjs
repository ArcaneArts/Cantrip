import assert from "node:assert/strict";
import { literal, stamp } from "./project-target-state.mjs";
export async function runLaneReservationCases({
  start,
  call,
  unchanged,
  seed,
  snapshot,
}) {
  let c = await start();
  await seed(
    `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state,branch,created_at,updated_at) VALUES('github-alpha-extra','github-alpha','alpha','extra','/fixture/extra','/fixture/extra',false,'cantrip','ready','feature-two',${literal(stamp)},${literal(stamp)}) ON CONFLICT(id) DO UPDATE SET branch='feature-two',lifecycle_state='ready'`,
  );
  let pending = await call(
    "schedule",
    "reserve first private transition",
    (i) => ({ expectedLane: c.ids[i], target: "github-alpha-feature" }),
  );
  const replaced = await call(
    "schedule",
    "replace pending transition destination",
    (i) => ({ expectedLane: c.ids[i], target: "github-alpha-extra" }),
  );
  let states = await snapshot(
    "replaced private reservation remains suspended with branch lease",
  );
  for (const [i, state] of states.entries()) {
    assert.equal(
      state.lanes.find((l) => l.id === pending[i].lane.id).state,
      "suspended",
    );
    assert.equal(
      state.lanes.find((l) => l.id === pending[i].lane.id).transition_kind,
      null,
    );
    assert.equal(
      state.lanes.find((l) => l.id === replaced[i].lane.id).state,
      "delivering",
    );
    assert.equal(state.leases.filter((l) => l.state === "active").length, 3);
  }
  for (const purpose of ["ordinary transition", "unique transition"]) {
    c = await start();
    await seed(
      "UPDATE chats SET active_worktree_id='github-alpha-feature',active_worker_id='alpha' WHERE id='contender'",
    );
    await call("start", "other chat holds private target " + purpose, {
      chat: "contender",
    });
    await unchanged("physical target uniqueness " + purpose, () =>
      call(
        "schedule",
        "physical target uniqueness " + purpose,
        (i) => ({
          expectedLane: c.ids[i],
          target: "github-alpha-feature",
          purpose,
        }),
        purpose.includes("unique")
          ? { error: true, laneError: "ExecutionLaneConflictError" }
          : { error: true, sqlstate: "23505" },
      ),
    );
  }
  c = await start();
  await seed(
    "UPDATE chats SET active_worktree_id='github-beta-feature' WHERE id='contender'",
  );
  await call("start", "other replica holds destination logical branch", {
    chat: "contender",
  });
  await unchanged("logical branch conflict rolls back target reservation", () =>
    call(
      "schedule",
      "logical branch conflict rolls back target reservation",
      (i) => ({ expectedLane: c.ids[i], target: "github-alpha-feature" }),
      { error: true, laneError: "ExecutionLaneConflictError" },
    ),
  );
  c = await start();
  await seed([
    "CREATE FUNCTION cancel_lease_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'lease retirement failure' USING ERRCODE='P0001'; END $$",
    "CREATE TRIGGER cancel_lease_fault BEFORE UPDATE ON project_branch_leases FOR EACH ROW WHEN (NEW.state='released') EXECUTE FUNCTION cancel_lease_fault()",
  ]);
  // Private cancellations retain leases. Their suspension must not invoke the
  // Primary-specific retirement path, even when that path would actually fail.
  pending = await call("schedule", "private cancel fault fixture", (i) => ({
    expectedLane: c.ids[i],
    target: "github-alpha-feature",
  }));
  for (const value of await call(
    "cancel",
    "private cancellation does not release branch lease",
    (i) => ({ lane: pending[i].lane.id }),
  ))
    assert.equal(value, true);
  await seed([
    "DROP TRIGGER cancel_lease_fault ON project_branch_leases",
    "DROP FUNCTION cancel_lease_fault()",
  ]);
  c = await start({ worktree: "github-alpha-feature" });
  pending = await call("schedule", "Primary cancel rollback fixture", (i) => ({
    expectedLane: c.ids[i],
    target: "github-alpha-main",
  }));
  await seed([
    "CREATE FUNCTION cancel_lease_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NOT EXISTS(SELECT 1 FROM chat_execution_lanes WHERE id=NEW.chat_execution_lane_id AND state='suspended' AND transition_kind IS NULL) THEN RAISE EXCEPTION 'cancellation not observed' USING ERRCODE='P0002'; END IF; RAISE EXCEPTION 'lease retirement failure' USING ERRCODE='P0001'; END $$",
    "CREATE TRIGGER cancel_lease_fault BEFORE UPDATE ON project_branch_leases FOR EACH ROW WHEN (NEW.state='released') EXECUTE FUNCTION cancel_lease_fault()",
  ]);
  await unchanged("Primary cancel lease failure restores delivering lane", () =>
    call(
      "cancel",
      "Primary cancel lease failure restores delivering lane",
      (i) => ({ lane: pending[i].lane.id }),
      { error: true, sqlstate: "P0001" },
    ),
  );
  await seed([
    "DROP TRIGGER cancel_lease_fault ON project_branch_leases",
    "DROP FUNCTION cancel_lease_fault()",
  ]);
  await call("cancel", "Primary cancel after rollback", (i) => ({
    lane: pending[i].lane.id,
  }));
  await snapshot("reservation boundaries complete");
}
