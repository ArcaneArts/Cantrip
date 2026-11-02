import assert from "node:assert/strict";
import { retainedPrompt, promptId } from "./native-settlement-fixtures.mjs";
import { literal } from "./project-target-state.mjs";
import { worktreeStatusResultSchema } from "../../packages/protocol/dist/index.js";
export async function runRecoveryCases(h) {
  const { observe, reset, seed, snapshot, standalone, owner } = h;
  const message = retainedPrompt().pendingMessage;
  const clean = async () => {
    await reset();
    await seed([
      "DELETE FROM agent_interaction_requests",
      "DELETE FROM chat_messages",
      "DELETE FROM task_dispatch_cycles",
      "SELECT setval(pg_get_serial_sequence('chat_messages','sequence'),1,false)",
      "UPDATE chats SET model_id='bootstrap-model',custom_subagent_model=false,subagent_model_id=NULL,subagent_reasoning_effort=NULL",
      "UPDATE user_settings SET default_model_id='bootstrap-model',auto_name_chats=false",
    ]);
  };
  const run = (name, fields = {}) =>
    observe(
      name,
      { chat: "chat", protectedMessage: message, ...fields },
      { op: "native-command-recovery", shape: "raw" },
    );
  const enqueue = (name, fields = {}) => {
    const mode = fields.mode ?? "default";
    const content = retainedPrompt({
      modelId: "bootstrap-model",
      ...fields.content,
    });
    content.classification = { ...content.classification, mode };
    content.pendingMessage = {
      ...content.pendingMessage,
      classification: { ...content.pendingMessage.classification, mode },
    };
    return observe(
      name,
      { action: "create-encrypted", chat: fields.chat ?? "chat", content },
      { op: "native-command-prompt-run", shape: "raw" },
    );
  };
  await clean();
  let values = await run(
    "queue dispatch with no actual input does not invoke a turn or account transfer",
  );
  for (const v of values) {
    assert.deepEqual(v.trace, []);
    assert.deepEqual(v.commands, []);
  }
  for (const [column, value] of [
    ["status", "'running'"],
    ["automation_paused", "true"],
  ]) {
    await clean();
    await enqueue("retain input while queue is not runnable " + column);
    await seed(`UPDATE chats SET ${column}=${value} WHERE id='chat'`);
    values = await run("actual chat state postpones queue execution " + column);
    for (const v of values) assert.deepEqual(v.trace, []);
  }
  await clean();
  await enqueue("frozen queue input is durable", { content: { frozen: true } });
  values = await run(
    "frozen input neither transfers an account nor acquires its claim",
  );
  for (const v of values) assert.deepEqual(v.trace, []);
  await clean();
  await enqueue("ordinary managed prompt before coordinator dispatch");
  values = await run(
    "actual queue authority prepares its account before owning the next opaque input",
  );
  for (const v of values) {
    assert.deepEqual(
      v.trace.map((x) => x.kind),
      ["prepare-account", "begin"],
    );
    const begin = v.trace[1];
    assert.equal(begin.input.text, "Encrypted queued prompt.");
    assert.equal(begin.options.queuedPromptId, promptId);
    assert.equal(
      begin.options.encryptedChatMessages.userMessage.id,
      message.id,
    );
    assert.equal(begin.options.managedQueueClaim.promptRevision, 0);
  }
  let states = await snapshot(
    "controlled turn boundary retains its real managed claim and input",
  );
  for (const s of states) {
    assert.equal(s.claims.length, 1);
    assert.equal(s.claims[0].status, "claimed");
    assert.equal(s.prompts[0].state, "claimed");
    assert.equal(s.queueInputs.length, 1);
  }
  await clean();
  await enqueue("managed input before simultaneous dispatch calls");
  values = await run(
    "simultaneous dispatch requests coalesce and reread committed running state",
    { count: 3, beginSql: "UPDATE chats SET status='running' WHERE id='chat'" },
  );
  for (const v of values)
    assert.equal(v.trace.filter((t) => t.kind === "begin").length, 1);
  await snapshot("coalesced dispatch retains exactly one actual managed claim");
  await clean();
  await enqueue("unclaimed input before account transfer failure");
  values = await run("account transfer failure occurs before any queue claim", {
    failAccount: true,
  });
  for (const v of values) {
    assert.ok(v.logs.some((l) => l.event === "chat.queue.dispatch-failed"));
    assert.ok(!v.trace.some((t) => t.kind === "begin"));
  }
  states = await snapshot(
    "failed account preparation leaves the queue unclaimed",
  );
  for (const s of states) {
    assert.equal(s.claims, null);
    assert.equal(s.prompts[0].state, "pending");
  }
  await clean();
  await enqueue("unadmitted input before controlled turn failure");
  values = await run(
    "failed turn bootstrap releases the actual unadmitted claim",
    { failBegin: true },
  );
  for (const v of values)
    assert.ok(
      v.logs.some((l) => l.errorMessage === "Controlled queued turn failure"),
    );
  states = await snapshot(
    "failed bootstrap preserves its rejected receipt and pending opaque input",
  );
  for (const s of states) {
    assert.equal(s.claims[0].status, "rejected");
    assert.equal(s.prompts[0].state, "pending");
  }
  values = await run(
    "same rejected prompt revision is not replayed by another dispatch",
  );
  for (const v of values) assert.ok(!v.trace.some((t) => t.kind === "begin"));
  for (const chat of ["task", standalone]) {
    await clean();
    await enqueue("unmanaged opaque queue input " + chat, { chat });
    values = await run(
      "unmanaged completed bootstrap deletes its actual queued input " + chat,
      { chat },
    );
    for (const v of values) {
      assert.deepEqual(
        v.trace.map((t) => t.kind),
        ["begin"],
      );
      assert.ok(!Object.hasOwn(v.trace[0].options, "managedQueueClaim"));
      assert.ok(v.events.some((e) => e.resource === "chat-queue"));
    }
    states = await snapshot("unmanaged queue deletion is durable " + chat);
    for (const s of states) {
      assert.equal(s.prompts, null);
      assert.equal(s.claims, null);
    }
  }
  await clean();
  await enqueue("managed Goal action retains its worker-protected input", {
    mode: "goal",
    content: { executionMethod: "thread/goal/set" },
  });
  values = await run(
    "managed Goal action uses actual model configuration and console preparation",
  );
  for (const v of values) {
    assert.deepEqual(
      v.trace.map((t) => t.kind),
      ["prepare-account"],
    );
    const command = v.commands.find(
      (c) => c.command.type === "chat.queue.execute",
    );
    assert.equal(command.command.executionMethod, "thread/goal/set");
    assert.equal(command.command.threadId, "recovery-thread");
    assert.equal(command.timeoutMs, 600000);
    assert.equal(command.command.protectedPrompt.id, message.id);
  }
  states = await snapshot(
    "native Goal dispatch commits its input and exact bound runtime",
  );
  for (const s of states) {
    assert.equal(s.messages.length, 1);
    assert.ok(s.runtimes.some((r) => r.codex_thread_id === "recovery-thread"));
    assert.equal(s.claims[0].status, "claimed");
  }
  await clean();
  await enqueue("Goal input before worker dispatch failure", {
    mode: "goal",
    content: { executionMethod: "thread/goal/set" },
  });
  values = await run(
    "native action worker failure releases the claim after durable input projection",
    { failCommand: "chat.queue.execute" },
  );
  for (const v of values)
    assert.ok(v.logs.some((l) => l.event === "chat.queue.dispatch-failed"));
  states = await snapshot(
    "native queue failure preserves committed message while releasing unadmitted claim",
  );
  for (const s of states) {
    assert.equal(s.messages.length, 1);
    assert.equal(s.claims[0].status, "rejected");
    assert.equal(s.prompts[0].state, "pending");
  }
  await clean();
  const config = {
    modelId: "bootstrap-model",
    reasoningEffort: null,
    customSubagentModel: false,
    subagentModelId: null,
    subagentReasoningEffort: null,
  };
  values = await run(
    "full model configuration uses real ownership and runtime fence",
    { action: "configure", configuration: config },
  );
  for (const v of values) assert.equal(v.results[0].modelId, "bootstrap-model");
  await run(
    "unowned configuration model is refused without replacing selection",
    {
      action: "configure",
      configuration: { ...config, modelId: "foreign-model" },
    },
  );
  await clean();
  values = await run("missing transition is observed rather than invented", {
    action: "transition",
  });
  for (const v of values) assert.deepEqual(v.results, [false]);
  await seed(
    "INSERT INTO project_worktrees(id,project_source_id,worker_id,name,branch,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES('recovery-tree','github-alpha','alpha','recovery','recovery','/fixture/recovery','/fixture/recovery',false,'cantrip','ready') ON CONFLICT(id) DO NOTHING",
  );
  const pending = async (
    chat = "chat",
    kind = "switch",
    target = "recovery-tree",
  ) =>
    seed(
      `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,transition_kind) VALUES('77777777-7777-4777-8777-000000000089',${literal(chat)},${literal(target)},'alpha','agent',true,'Controlled recovery','delivering',${literal(kind)})`,
    );
  for (const fields of [
    { connected: false },
    { paused: true },
    { running: true },
  ]) {
    await clean();
    await pending();
    if (fields.paused)
      await seed("UPDATE chats SET automation_paused=true WHERE id='chat'");
    if (fields.running)
      await seed("UPDATE chats SET status='running' WHERE id='chat'");
    values = await run(
      "pending transition retains real lane when continuation is unavailable " +
        JSON.stringify(fields),
      { action: "transition", ...fields },
    );
    for (const v of values) {
      assert.deepEqual(v.results, [true]);
      assert.deepEqual(v.commands, []);
    }
    await snapshot("pending lane retained " + JSON.stringify(fields));
  }
  await clean();
  await pending();
  values = await run(
    "worktree transition applies actual placement and protects the system continuation",
    { action: "transition" },
  );
  for (const v of values) {
    assert.deepEqual(v.results, [true]);
    const begin = v.trace.find((t) => t.kind === "begin");
    assert.equal(begin.context.worktreeId, "recovery-tree");
    assert.equal(begin.options.messageRole, "system");
    assert.equal(begin.options.acquiringActor, "agent");
    assert.ok(
      v.commands.some((c) => c.command.type === "chat.message.protect"),
    );
  }
  states = await snapshot(
    "applied transition commits target placement before the controlled turn boundary",
  );
  for (const s of states) {
    assert.equal(
      s.chats.find((c) => c.id === "chat").active_worktree_id,
      "recovery-tree",
    );
    assert.equal(s.lanes[0].state, "suspended");
  }
  await clean();
  await pending();
  values = await run(
    "failed automatic continuation retains moved placement and protects its error message",
    { action: "transition", failBegin: true },
  );
  for (const v of values)
    assert.ok(
      v.logs.some(
        (l) => l.message === "Could not start a worktree continuation",
      ),
    );
  states = await snapshot(
    "continuation failure cannot undo its committed worktree move",
  );
  for (const s of states) {
    assert.equal(
      s.chats.find((c) => c.id === "chat").active_worktree_id,
      "recovery-tree",
    );
    assert.equal(s.messages.length, 1);
  }
  await clean();
  await pending("task");
  await seed("UPDATE chats SET status='offline' WHERE id='task'");
  values = await run(
    "live Task recovery runs before an old worktree handoff can move it",
    { chat: "task", action: "transition", recoverTask: true },
  );
  for (const v of values) {
    assert.deepEqual(
      v.trace.map((t) => t.kind),
      ["recover-task"],
    );
    assert.deepEqual(v.commands, []);
  }
  await snapshot(
    "adopted Task recovery leaves the old pending transition intact",
  );
  await clean();
  await pending("task");
  values = await run(
    "Task Goal continuation gets the actual moved context before ordinary reprotection",
    { chat: "task", action: "transition", continueGoal: true },
  );
  for (const v of values) {
    assert.deepEqual(
      v.trace.map((t) => t.kind),
      ["continue-goal"],
    );
    assert.deepEqual(v.commands, []);
  }
  await clean();
  await pending();
  values = await run(
    "worker recovery reconciles Tasks before resuming pending worktree transitions",
    { action: "resume" },
  );
  for (const v of values) assert.equal(v.trace[0].kind, "reconcile-tasks");
  await snapshot("worker recovery retains its applied transition");
  const status = worktreeStatusResultSchema.parse({
    worktree: {
      path: "/fixture/recovery",
      head: null,
      branch: "main",
      detached: false,
      isPrimary: false,
      managed: true,
      locked: false,
      lockReason: null,
      prunable: false,
      pruneReason: null,
      missing: false,
    },
    status: {
      branch: "main",
      head: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [],
      branches: [],
    },
  });
  const release = async () => {
    await clean();
    await seed(
      "UPDATE chats SET active_worktree_id='recovery-tree' WHERE id='chat'",
    );
    await pending("chat", "release", "github-alpha-main");
  };
  await release();
  const dirty = structuredClone(status);
  dirty.status.files.push({
    path: "changed.txt",
    originalPath: null,
    indexStatus: " ",
    worktreeStatus: "M",
    staged: false,
    unstaged: true,
  });
  values = await run(
    "worktree release checks actual worker changes before cancelling its pending lane",
    { action: "transition", worktreeStatus: dirty },
  );
  for (const v of values) {
    assert.deepEqual(v.results, [false]);
    assert.ok(!v.trace.some((t) => t.kind === "begin"));
    assert.ok(v.commands.some((c) => c.command.type === "worktree.status"));
  }
  states = await snapshot(
    "new worker changes cancel release and preserve current placement",
  );
  for (const s of states) {
    assert.equal(
      s.chats.find((c) => c.id === "chat").active_worktree_id,
      "recovery-tree",
    );
    assert.equal(s.lanes[0].transition_kind, null);
    assert.equal(s.messages.length, 1);
  }
  await release();
  values = await run(
    "verified clean worktree release returns to Primary before continuation",
    { action: "transition", worktreeStatus: status },
  );
  for (const v of values) {
    assert.deepEqual(v.results, [true]);
    assert.equal(
      v.trace.find((t) => t.kind === "begin").context.worktreeId,
      "github-alpha-main",
    );
  }
  await snapshot("verified release preserves actual Primary transition state");
  await release();
  values = await run(
    "failed worker release verification keeps its actual pending transition",
    { action: "transition", failCommand: "worktree.status" },
  );
  for (const v of values) {
    assert.deepEqual(v.results, [true]);
    assert.ok(
      v.logs.some(
        (l) => l.message === "Could not verify a pending worktree release",
      ),
    );
    assert.ok(!v.trace.some((t) => t.kind === "begin"));
  }
  await snapshot(
    "failed release verification does not move or cancel the pending lane",
  );
}
