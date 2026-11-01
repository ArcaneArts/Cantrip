import assert from "node:assert/strict";
import { retainedPrompt } from "./native-settlement-fixtures.mjs";
import { eventPlan } from "./native-event-fixtures.mjs";
import { protectedInteraction } from "./agent-interaction-fixtures.mjs";
export async function runTurnExecutionCases(h) {
  const { observe, reset, seed, snapshot, standalone } = h;
  const message = retainedPrompt().pendingMessage;
  const response = {
    id: "456789ab-1234-4234-8234-000000000019",
    idempotencyKey: "stream-response",
  };
  const assistant = {
    ...message,
    ...response,
    classification: { ...message.classification, role: "assistant" },
  };
  const result = {
    threadId: "stream-thread",
    turnId: "stream-turn",
    text: "",
    status: "completed",
    structuredResult: { message: assistant },
  };
  const options = { encryptedChatMessages: { userMessage: message, response } };
  const clean = async () => {
    await reset();
    await seed([
      "DELETE FROM agent_interaction_requests",
      "DELETE FROM chat_messages",
      "DELETE FROM task_dispatch_cycles",
      "DELETE FROM model_behavior_observations",
      "DELETE FROM token_usage_records",
      "SELECT setval(pg_get_serial_sequence('chat_messages','sequence'),1,false)",
      "UPDATE chats SET model_id='bootstrap-model',custom_subagent_model=false,subagent_model_id=NULL,subagent_reasoning_effort=NULL,protected_plan=NULL,has_pending_plan_question=false,plan_mode='default'",
      "UPDATE user_settings SET auto_name_chats=false,default_model_id='bootstrap-model'",
    ]);
  };
  const run = (name, fields = {}) =>
    observe(
      name,
      {
        chat: "chat",
        input: { text: "", modelId: "bootstrap-model" },
        options,
        protectedMessage: message,
        taskMessage: message,
        attempts: [{ result }],
        ...fields,
      },
      { op: "native-command-turn-execution", shape: "raw" },
    );
  const metrics = (name) =>
    observe(
      name,
      {
        sql: "SELECT jsonb_build_object('usage',(SELECT jsonb_agg(jsonb_build_object('source',source_key,'chat',chat_id,'route',model_route_id,'turn',turn_id,'kind',attempt_kind,'status',attempt_status,'input',input_tokens,'output',output_tokens,'cached',cached_input_tokens,'reasoning',reasoning_output_tokens,'started',started_at IS NOT NULL,'completed',completed_at IS NOT NULL,'finalized',finalized_at IS NOT NULL) ORDER BY source_key) FROM token_usage_records),'behavior',(SELECT jsonb_agg(jsonb_build_object('source',source_key,'route',model_route_id,'status',attempt_status,'routeIndex',route_attempt_index,'retries',retry_failover_count,'native',native_attribution,'final',final_answer_appeared,'approvals',approval_request_count,'files',files_changed_count,'tools',tool_call_count,'interrupted',user_interrupted) ORDER BY source_key) FROM model_behavior_observations)) result",
      },
      { op: "query-json", shape: "raw" },
    );
  await clean();
  let values = await run(
    "full controlled Agent stream commits encrypted final output and finishes its actual lane",
  );
  for (const value of values) {
    assert.equal(value.beginError, null);
    assert.equal(
      value.commands.filter((c) => c.command.type === "chat.turn").length,
      1,
    );
    assert.equal(
      value.commands.find((c) => c.command.type === "chat.turn").timeoutMs,
      null,
    );
    assert.equal(value.logs.at(-1).message, "Agent turn completed");
    assert.ok(value.trace.some((t) => t.kind === "dispatch-queue"));
  }
  let states = await snapshot(
    "completed controlled Agent turn retains both actual opaque rows",
  );
  for (const state of states) {
    assert.equal(state.messages.length, 2);
    assert.equal(state.chats.find((c) => c.id === "chat").status, "idle");
  }
  await metrics("controlled Agent completion records real finalized analytics");
  await clean();
  values = await run(
    "streamed protected final prevents a duplicate result append",
    {
      attempts: [
        {
          events: [
            {
              type: "agent.protected-message",
              message: assistant,
              telemetry: {
                kind: "message",
                phase: "final_answer",
                streaming: false,
                turnId: "<turn>",
              },
            },
          ],
          result,
        },
      ],
    },
  );
  for (const value of values)
    assert.equal(value.logs.at(-1).message, "Agent turn completed");
  states = await snapshot("streamed final remains one durable assistant row");
  for (const state of states) assert.equal(state.messages.length, 2);
  await metrics(
    "streamed final marks actual native turn and final-answer telemetry",
  );
  await clean();
  values = await run(
    "visible worker commentary goes through actual endpoint protection",
    {
      attempts: [
        {
          events: [
            {
              type: "agent.message",
              message: {
                id: "commentary",
                text: "stream-private-commentary",
                phase: "commentary",
                streaming: true,
                correlation: {
                  sourceMethod: "item/agentMessage/delta",
                  diagnosticId: null,
                  threadId: "stream-thread",
                  turnId: "stream-turn",
                  itemId: "item",
                },
              },
            },
          ],
          result,
        },
      ],
    },
  );
  for (const value of values) {
    const protect = value.commands.find(
      (c) => c.command.type === "chat.message.protect",
    );
    assert.equal(
      protect.command.message.content[0].text,
      "stream-private-commentary",
    );
    assert.equal(
      protect.command.message.content[0].sourceEvent.operationId,
      message.id,
    );
  }
  states = await snapshot(
    "visible commentary retains only worker-protected content",
  );
  for (const state of states)
    assert.ok(!JSON.stringify(state).includes("stream-private-commentary"));
  await clean();
  const opaqueRequest = protectedInteraction("stream-approval");
  const request = {
    requestKey: opaqueRequest.requestKey,
    threadId: "<thread>",
    turnId: "<turn>",
    itemId: null,
    classification: opaqueRequest.classification,
    protectedPayload: opaqueRequest.protectedPayload,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  values = await run(
    "protected interaction survives request and ordered clearing",
    {
      attempts: [
        {
          events: [
            { type: "agent.interaction.requested.protected", request },
            {
              type: "agent.interaction.cleared",
              requestKey: "stream-approval",
            },
          ],
          result,
        },
      ],
    },
  );
  for (const value of values)
    assert.equal(value.logs.at(-1).message, "Agent turn completed");
  states = await snapshot(
    "cleared protected interaction retains its actual interruption",
  );
  for (const state of states)
    assert.equal(state.interactions[0].status, "interrupted");
  await metrics(
    "protected approval counts are written by the real behavior writer",
  );
  await clean();
  values = await run(
    "plaintext plan state fails the turn without persisting a plaintext plan",
    {
      attempts: [
        {
          events: [
            {
              type: "agent.plan.updated",
              turnId: "stream-turn",
              explanation: null,
              steps: [],
            },
          ],
          result,
        },
      ],
    },
  );
  for (const value of values) {
    assert.ok(
      value.logs.some(
        (l) =>
          l.message === "Agent turn failed" &&
          l.errorMessage === "Worker emitted plaintext Plan Mode state.",
      ),
    );
    assert.ok(!value.logs.some((l) => l.message === "Agent turn completed"));
  }
  states = await snapshot(
    "rejected plaintext plan closes the actual native lane",
  );
  for (const state of states) {
    assert.equal(state.chats.find((c) => c.id === "chat").status, "failed");
    assert.equal(state.messages.length, 1);
  }
  await clean();
  const planMessage = {
    ...message,
    classification: { ...message.classification, mode: "plan" },
  };
  const planAssistant = {
    ...assistant,
    classification: { ...assistant.classification, mode: "plan" },
  };
  values = await run("protected Plan Mode state uses the actual plan writer", {
    input: { text: "", modelId: "bootstrap-model", mode: "plan" },
    options: { encryptedChatMessages: { userMessage: planMessage, response } },
    attempts: [
      {
        events: [
          {
            type: "agent.plan.protected",
            turnId: "stream-turn",
            state: eventPlan,
          },
        ],
        result: { ...result, structuredResult: { message: planAssistant } },
      },
    ],
  });
  for (const value of values)
    assert.equal(value.logs.at(-1).message, "Agent turn completed");
  states = await snapshot("protected plan survives completed turn");
  for (const state of states) {
    const row = state.chats.find((c) => c.id === "chat");
    assert.equal(row.plan_mode, "plan");
    assert.equal(row.has_pending_plan_question, true);
  }
  await clean();
  values = await run(
    "standalone controlled turn uses scratch attribution and skips worktree continuation",
    { chat: standalone },
  );
  for (const value of values) {
    assert.equal(value.result.contextKind, "standalone");
    assert.ok(!value.trace.some((t) => t.kind === "continue-worktree"));
    assert.ok(value.trace.some((t) => t.kind === "dispatch-queue"));
  }
  await snapshot("standalone completion preserves its actual scratch runtime");
  await clean();
  values = await run(
    "invalid encrypted result metadata fails after the worker reply",
    {
      attempts: [
        {
          result: {
            ...result,
            structuredResult: {
              message: { ...assistant, idempotencyKey: "foreign-result" },
            },
          },
        },
      ],
    },
  );
  for (const value of values)
    assert.ok(value.logs.some((l) => l.message === "Agent turn failed"));
  states = await snapshot(
    "invalid final metadata cannot append another response",
  );
  for (const state of states) assert.equal(state.messages.length, 1);
  await clean();
  values = await run(
    "completed callback sees actual attribution before queue continuation",
    { afterCompleted: true },
  );
  for (const value of values) {
    const hook = value.trace.find((t) => t.kind === "after-completed");
    assert.equal(hook.messageId, message.id);
    assert.equal(hook.turnId, "stream-turn");
    assert.ok(
      value.trace.findIndex((t) => t.kind === "after-completed") <
        value.trace.findIndex((t) => t.kind === "dispatch-queue"),
    );
  }
  await clean();
  values = await run(
    "completed callback failure cannot undo the durable completed turn",
    { afterCompleted: true, failHook: "after-completed" },
  );
  for (const value of values) {
    assert.ok(
      value.logs.some(
        (l) =>
          l.message === "Task post-processing failed after its turn completed",
      ),
    );
    assert.equal(value.logs.at(-1).message, "Agent turn completed");
    assert.ok(value.trace.some((t) => t.kind === "dispatch-queue"));
  }
  states = await snapshot(
    "post-completion callback failure preserves idle lane and opaque final",
  );
  for (const state of states) {
    assert.equal(state.messages.length, 2);
    assert.equal(state.chats.find((c) => c.id === "chat").status, "idle");
  }
  await clean();
  values = await run(
    "failed callback failure cannot prevent durable failure settlement",
    {
      afterFailed: true,
      failHook: "after-failed",
      attempts: [{ error: { message: "controlled worker failure" } }],
    },
  );
  for (const value of values) {
    assert.ok(value.trace.some((t) => t.kind === "after-failed"));
    assert.ok(
      value.logs.some(
        (l) =>
          l.message === "Task post-processing failed after its turn failed",
      ),
    );
    assert.ok(value.trace.some((t) => t.kind === "dispatch-queue"));
  }
  await snapshot("failed callback preserves closed failed lane");
  await clean();
  values = await run(
    "pending worktree transition retains completion instead of dispatching the next queue item",
    { pendingTransition: true },
  );
  for (const value of values) {
    assert.ok(value.trace.some((t) => t.kind === "continue-worktree"));
    assert.ok(!value.trace.some((t) => t.kind === "dispatch-queue"));
  }
  await clean();
  const taskUser = {
    ...message,
    classification: { ...message.classification, mode: "goal" },
  };
  values = await run(
    "Task Goal worker loss pauses its actual automation without replaying uncertain input",
    {
      chat: "task",
      input: { text: "", modelId: "bootstrap-model", mode: "goal" },
      options: { encryptedTaskMessages: { userMessage: taskUser, response } },
      afterFailed: true,
      attempts: [
        {
          error: {
            message: "private-worker-disconnect-marker",
            unavailable: true,
          },
        },
      ],
    },
  );
  for (const value of values) {
    assert.ok(value.logs.some((l) => l.reasonCode === "worker-unavailable"));
    assert.ok(
      !JSON.stringify(value.logs).includes("private-worker-disconnect-marker"),
    );
    assert.ok(value.trace.some((t) => t.kind === "after-failed"));
    assert.ok(!value.trace.some((t) => t.kind === "dispatch-queue"));
  }
  states = await snapshot(
    "interrupted Task Goal leaves durable idle state with automation paused",
  );
  for (const state of states) {
    const row = state.chats.find((c) => c.id === "task");
    assert.equal(row.status, "idle");
    assert.equal(row.automation_paused, true);
    assert.equal(state.messages.length, 1);
  }
  await metrics(
    "interrupted Task Goal records actual failed-attempt analytics",
  );
  await clean();
  values = await run(
    "completed Task stream persists actual opaque Task output and workload fanout",
    {
      chat: "task",
      options: { encryptedTaskMessages: { userMessage: message, response } },
    },
  );
  for (const value of values) {
    assert.equal(value.logs.at(-1).message, "Agent turn completed");
    assert.ok(value.trace.some((t) => t.kind === "dispatch-queue"));
  }
  states = await snapshot(
    "completed Task turn retains its actual response and closed lane",
  );
  for (const state of states) {
    assert.equal(state.messages.length, 2);
    assert.equal(state.chats.find((c) => c.id === "task").status, "idle");
  }
  await clean();
  const structuredOptions = {
    ...options,
    structuredResult: { outputSchema: { type: "object" } },
  };
  values = await run(
    "structured completion and post-processing preserve real callback and queue order",
    {
      options: structuredOptions,
      structuredAfter: true,
      afterCompleted: true,
      failHook: "structured-after",
    },
  );
  for (const value of values) {
    assert.deepEqual(
      value.trace
        .filter(
          (t) =>
            t.kind.startsWith("structured") || t.kind === "after-completed",
        )
        .map((t) => t.kind),
      ["structured-completed", "structured-after", "after-completed"],
    );
    assert.ok(
      value.logs.some(
        (l) =>
          l.message ===
          "Task post-processing failed after its structured turn completed",
      ),
    );
    assert.equal(value.logs.at(-1).message, "Agent turn completed");
  }
  states = await snapshot(
    "structured completion delegates its result without appending a normal assistant row",
  );
  for (const state of states) assert.equal(state.messages.length, 1);
  await clean();
  values = await run(
    "structured result callback failure invokes actual failed settlement after worker completion",
    {
      options: structuredOptions,
      failHook: "structured-completed",
      afterFailed: true,
    },
  );
  for (const value of values) {
    assert.deepEqual(
      value.trace
        .filter(
          (t) => t.kind.startsWith("structured") || t.kind === "after-failed",
        )
        .map((t) => t.kind),
      ["structured-completed", "structured-failed", "after-failed"],
    );
    assert.ok(value.logs.some((l) => l.message === "Agent turn failed"));
  }
  await metrics(
    "structured completion failure preserves actual analytics finalization boundaries",
  );
  await clean();
  await seed(
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('stream-secondary','bootstrap-model','bootstrap-provider','bootstrap-model',1,true)",
  );
  try {
    values = await run(
      "rate limit before any worker activity fails over and completes on its next actual route",
      { attempts: [{ error: { message: "rate limit" } }, { result }] },
    );
    for (const value of values) {
      assert.equal(
        value.commands.filter((c) => c.command.type === "chat.turn").length,
        2,
      );
      assert.equal(value.logs.at(-1).message, "Agent turn completed");
      assert.ok(
        value.logs.some((l) => l.event === "chat.turn.route-failed-over"),
      );
    }
    await metrics(
      "route failover retains distinct failed and completed attempt writers",
    );
    await clean();
    values = await run(
      "non-BMP separator preserves JavaScript retry matching rather than broadening failover",
      { attempts: [{ error: { message: "rate😀limit" } }, { result }] },
    );
    for (const value of values) {
      assert.equal(
        value.commands.filter((c) => c.command.type === "chat.turn").length,
        1,
      );
      assert.ok(value.logs.some((l) => l.message === "Agent turn failed"));
    }
    await clean();
    values = await run(
      "streamed worker activity prevents an otherwise retryable rate-limit failover",
      {
        attempts: [
          {
            events: [
              {
                type: "agent.protected-message",
                message: assistant,
                telemetry: {
                  kind: "message",
                  phase: "commentary",
                  streaming: true,
                  turnId: "<turn>",
                },
              },
            ],
            error: { message: "rate limit" },
          },
          { result },
        ],
      },
    );
    for (const value of values) {
      assert.equal(
        value.commands.filter((c) => c.command.type === "chat.turn").length,
        1,
      );
      assert.ok(
        !value.logs.some((l) => l.event === "chat.turn.route-failed-over"),
      );
    }
    await snapshot(
      "activity before a retryable failure is retained without repeating the worker input",
    );
  } finally {
    await seed("DELETE FROM model_routes WHERE id='stream-secondary'");
  }
}
