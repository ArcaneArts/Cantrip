import assert from "node:assert/strict";
import { modelFunctions } from "../server-rust/task-model-provider.mjs";
import { createPreparedProjectChat } from "./console-interaction-cases.mjs";

export async function verifyGuestGoalControls({
  call,
  eventually,
  createModel,
  encryptedTurn,
  openMessage,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  repositoryKey,
  guest,
  startWorker,
  stopWorker,
}) {
  const { model, profile } = await createModel("Guest Goal fixture");
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: profile.id,
    autoNameChats: false,
  });
  const { chatUrl, placement } = await createPreparedProjectChat({
    call,
    eventually,
    ownerId,
    workerId,
    keyRevision,
    labelKey,
    title: "Cantrip OS Goal",
    beforeChat: ({ projectId }) =>
      guest.placeProject({
        call,
        ownerId,
        workerId,
        keyRevision,
        projectId,
        repositoryKey,
      }),
  });
  const goalUrl = chatUrl + "/goal?encrypted=1";
  const read = () => call("GET", goalUrl, 200);
  const objective = "Read the assigned Linux workspace and complete the Goal.";
  const updated = "Retain this edited Linux Goal objective.";
  const { threadId } = await call("POST", chatUrl + "/sync", 200, {});
  assert.equal((await read()).goal, null);
  const shell = model.reply({ hold: true });
  const finish = model.reply({ hold: true });
  const answer = model.reply({
    text: "Verified the assigned Linux Goal workspace.",
  });
  const resumed = model.reply({ hold: true });
  const resumedAnswer = model.reply({
    text: "Completed the edited Linux Goal.",
  });
  const modelCalls = () =>
    model.requests.filter(({ method }) => method === "POST").length;
  const verifyGoal = async (status, text) => {
    const snapshot = await read();
    assert.equal(snapshot.kind, "chat-encrypted");
    assert.equal(snapshot.goal?.threadId, threadId);
    assert.equal(snapshot.goal.status, status);
    assert.equal(snapshot.goal.objective, undefined);
    const plaintext = await openMessage(snapshot.goal.protectedObjective);
    assert.equal(plaintext.content[0].text, text);
  };
  const completeGoal = async (reply, terminal) => {
    const complete = modelFunctions(reply.request.input.tools).find(
      ({ name }) => name === "update_goal" || name.endsWith("__update_goal"),
    );
    assert.ok(complete);
    reply.calls = [{ ...complete, arguments: { status: "complete" } }];
    reply.release();
    await eventually(
      () => terminal.request,
      (request) => assert.equal(request?.completed, true),
    );
    await eventually(read, (snapshot) =>
      assert.equal(snapshot.goal?.status, "complete"),
    );
  };
  try {
    await call("POST", goalUrl, 202, { objective, tokenBudget: 50_000 });
    await eventually(
      () => shell.request,
      (request) => assert.ok(request, "The guest Goal did not run."),
    );
    await verifyGoal("active", objective);
    const exec = modelFunctions(shell.request.input.tools).find(
      ({ name }) => name === "exec_command" || name.endsWith("__exec_command"),
    );
    assert.ok(exec, "The guest Goal must expose its native shell.");
    shell.calls = [
      { ...exec, arguments: { cmd: "uname -s && pwd", yield_time_ms: 1000 } },
    ];
    shell.release();
    await eventually(
      () => finish.request,
      (request) => assert.ok(request, "The guest shell did not return."),
    );
    const output = finish.request.input.input
      .filter(({ type }) => type === "function_call_output")
      .map(({ output }) => output)
      .join("\n");
    assert.ok(
      output.includes(
        "Linux\n/var/lib/cantrip-os-workspaces/homes/" +
          placement.guestWorkspaceId +
          "/checkouts/",
      ),
      output,
    );
    await completeGoal(finish, answer);
    await verifyGoal("complete", objective);
    assert.equal(modelCalls(), 3);

    assert.deepEqual(await stopWorker(), { code: 0, signal: null });
    await startWorker();
    await eventually(read, (snapshot) =>
      assert.equal(snapshot.goal?.status, "complete"),
    );
    await verifyGoal("complete", objective);
    const { message } = await encryptedTurn(updated, profile.id, "goal");
    await call("PATCH", goalUrl, 200, {
      status: "paused",
      protectedObjective: message,
    });
    await verifyGoal("paused", updated);
    assert.equal(modelCalls(), 3);
    await call("PATCH", goalUrl, 200, { status: "active" });
    await eventually(
      () => resumed.request,
      (request) => assert.ok(request),
    );
    await verifyGoal("active", updated);
    await completeGoal(resumed, resumedAnswer);
    await verifyGoal("complete", updated);
    assert.deepEqual(await call("DELETE", goalUrl, 200), { cleared: true });
    assert.equal((await read()).goal, null);
    assert.equal(modelCalls(), 5);
    assert.deepEqual(model.failures, []);
    console.log(
      JSON.stringify({ suite: "native-guest-goal-controls", passed: true }),
    );
  } finally {
    shell.release();
    finish.release();
    resumed.release();
  }
}
