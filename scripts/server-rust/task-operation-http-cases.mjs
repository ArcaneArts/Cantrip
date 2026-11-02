import assert from "node:assert/strict";
import { taskStart } from "./task-wire-fixtures.mjs";
import { settingsChat } from "./native-settings-http-fixture.mjs";

const id = (n) => `e3e3e3e3-3333-4333-8333-${String(n).padStart(12, "0")}`;
export const operationTasks = [
  { chat: id(1), state: "draft", route: "start", kind: "direct" },
  { chat: id(2), state: "draft", route: "plan", kind: "initial-plan" },
  { chat: id(3), state: "review", route: "continue", kind: "continue-plan" },
  {
    chat: id(4),
    state: "review",
    route: "begin-implementation",
    kind: "finalize",
  },
  { chat: id(5), state: "failed", route: "retry", kind: "initial-plan" },
];

export async function taskOperationHttpCases({
  h,
  result,
  prove,
  missing,
  draft,
  profile,
}) {
  const visit = (...args) => h.visit(...args);
  for (const route of [
    "start",
    "plan",
    "continue",
    "begin-implementation",
    "retry",
  ]) {
    for (const [label, body] of [
      ["missing fields", {}],
      ["null", null],
      ["array", []],
      ["invalid UUID", { operationId: "bad", rowVersion: 1 }],
      ["zero revision", { operationId: id(20), rowVersion: 0 }],
    ]) {
      await visit(
        `invalid ${route} ${label}`,
        "POST",
        `/api/tasks/${draft}/${route}`,
        { status: 400, json: body },
      );
    }
    await visit(
      `missing Task ${route}`,
      "POST",
      `/api/tasks/${missing}/${route}`,
      { status: 404, json: { operationId: id(20), rowVersion: 1 } },
    );
    await visit(
      `ordinary chat cannot ${route}`,
      "POST",
      `/api/tasks/${settingsChat}/${route}`,
      { status: 404, json: { operationId: id(20), rowVersion: 1 } },
    );
    if (profile === "accounts")
      await visit(
        `foreign Task cannot ${route}`,
        "POST",
        `/api/tasks/${draft}/${route}`,
        {
          client: "other",
          status: 404,
          json: { operationId: id(20), rowVersion: 1 },
        },
      );
  }
  for (const [label, body] of [
    ["unknown key", { prompt: "never accepted" }],
    ["array", []],
    ["string", "invalid"],
  ]) {
    await visit(
      `invalid recover ${label}`,
      "POST",
      `/api/tasks/${draft}/recover`,
      { status: 400, json: body },
    );
  }
  await visit(
    "missing Task recovery",
    "POST",
    `/api/tasks/${missing}/recover`,
    { status: 404 },
  );
  await visit(
    "ordinary chat recovery",
    "POST",
    `/api/tasks/${settingsChat}/recover`,
    { status: 404 },
  );
  await visit(
    "draft has no retained implementation",
    "POST",
    `/api/tasks/${draft}/recover`,
    { status: 409 },
  );
  await visit(
    "null recovery uses empty strict input",
    "POST",
    `/api/tasks/${draft}/recover`,
    { status: 409, json: null },
  );
  await visit(
    "draft has no failed operation",
    "POST",
    `/api/tasks/${draft}/retry`,
    { status: 409, json: { operationId: id(30), rowVersion: 2 } },
  );
  await visit(
    "legacy encrypted retry kind must match",
    "POST",
    `/api/tasks/${operationTasks[4].chat}/retry`,
    {
      status: 409,
      json: taskStart("direct", operationTasks[4].chat, 1, 1, id(31)),
    },
  );
  if (profile === "accounts")
    await visit(
      "foreign Task cannot recover",
      "POST",
      `/api/tasks/${draft}/recover`,
      { client: "other", status: 404, json: {} },
    );
  const start = h.live.history.length;
  const admissions = new Map();
  function admission(name, value) {
    const code = value.dispatch.eligibilityCode;
    assert.ok(
      code === null || code === "project-paused",
      "only pending or observed paused-project eligibility is valid",
    );
    result.admissionEligibility ??= [];
    result.admissionEligibility.push({ name, chatId: value.chatId, code });
    // A previous scheduler tick may finish during admission's SQL awaits.
    // Keep the actual value above, compare every other response field, then
    // require the full settled reply below. Source and Rust can both win this
    // race; neither is allowed to invent a different eligibility decision.
    result.observations.find(
      (entry) => entry.name === name,
    ).body.dispatch.eligibilityCode = "<in-flight scheduler eligibility>";
  }
  for (let index = 0; index < operationTasks.length; index++) {
    const { chat, route, kind } = operationTasks[index];
    const input = {
      operationId: id(100 + index),
      rowVersion: 1,
      ignoredExtension: true,
    };
    const queued = await prove(
      await visit(
        `queue ${kind} through ${route}`,
        "POST",
        `/api/tasks/${chat}/${route}`,
        { status: 202, json: input },
      ),
    );
    assert.equal(queued.dispatch.state, "queued");
    assert.equal(queued.dispatch.operationKind, kind);
    assert.equal(queued.dispatch.operationId, input.operationId);
    assert.equal(queued.rowVersion, 1);
    admission(`queue ${kind} through ${route}`, queued);
    admissions.set(chat, queued);
    if (index === 0) {
      const replay = await prove(
        await visit(
          "replay queued operation before revision check",
          "POST",
          `/api/tasks/${chat}/${route}`,
          { status: 202, json: { ...input, rowVersion: 999 } },
        ),
      );
      // Eligibility can advance between replies as the real scheduler runs.
      // Replays retain the same admission and encrypted Task, even with a stale
      // caller revision; scheduler observations are not new admissions.
      for (const key of [
        "id",
        "operationId",
        "operationKind",
        "state",
        "fencingToken",
        "fifoCreatedAt",
        "createdAt",
      ])
        assert.deepEqual(replay.dispatch[key], queued.dispatch[key]);
      assert.equal(replay.rowVersion, queued.rowVersion);
      assert.deepEqual(replay.protectedContent, queued.protectedContent);
      admission("replay queued operation before revision check", replay);
      await visit(
        "operation ID cannot change kind",
        "POST",
        `/api/tasks/${chat}/plan`,
        { status: 409, json: input },
      );
    }
    result.queuedOperations ??= [];
    result.queuedOperations.push({
      chat,
      kind,
      operationId: input.operationId,
      rowVersion: queued.rowVersion,
      state: queued.dispatch.state,
    });
  }
  result.eligibilityPolls = [];
  for (const { chat, kind } of operationTasks) {
    const end = Date.now() + 15000;
    for (;;) {
      const label = `poll scheduler eligibility ${chat}`;
      const observation = await h.fixture.observe(
        label,
        "GET",
        `/api/tasks/${chat}`,
      );
      const value = h.fixture.records.get(label);
      assert.deepEqual(
        value.protectedContent,
        admissions.get(chat).protectedContent,
      );
      result.eligibilityPolls.push({ chatId: chat, observation });
      if (value.dispatch.eligibilityCode === "project-paused") break;
      assert.equal(value.dispatch.eligibilityCode, null);
      assert.ok(
        Date.now() < end,
        "admitted Task reaches the actual paused-project observation",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const settled = await prove(
      await visit(`settled ${kind} admission`, "GET", `/api/tasks/${chat}`),
    );
    assert.equal(settled.dispatch.eligibilityCode, "project-paused");
    assert.equal(settled.dispatch.state, "queued");
    assert.equal(settled.dispatch.id, admissions.get(chat).dispatch.id);
  }
  await h.live.ping("Task admission notices");
  result.operationEvents = h.live.history
    .slice(start)
    .filter((event) => event.type === "event" && event.resource === "task")
    .map(({ scope, resource, action, entityId, revision, payload }) => ({
      scope,
      resource,
      action,
      entityId,
      revision,
      payload,
    }));
  assert.equal(
    result.operationEvents.filter((event) => event.scope.kind === "chat")
      .length,
    6,
  );
  // Project fanout is admitted separately from the synchronous chat event.
  const end = Date.now() + 15000;
  while (
    h.live.history
      .slice(start)
      .filter(
        (event) =>
          event.type === "event" &&
          event.resource === "task" &&
          event.scope.kind === "project",
      ).length !== 6
  ) {
    assert.ok(
      Date.now() < end,
      "all admitted Task operations publish project fanout",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  result.operationEvents = h.live.history
    .slice(start)
    .filter((event) => event.type === "event" && event.resource === "task")
    .map(({ scope, resource, action, entityId, revision, payload }) => ({
      scope,
      resource,
      action,
      entityId,
      revision,
      payload,
    }));
  assert.equal(result.operationEvents.length, 12);
}
