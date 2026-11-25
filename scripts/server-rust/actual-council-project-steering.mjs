import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { projectToolOutput } from "./actual-council-project-creation.mjs";
import { eventually } from "./full-worker.mjs";
import { literal } from "./project-target-state.mjs";

export const projectSteeringText =
  "Steer the active project Agent with this new detail 🌲.";

async function readTrace(marker) {
  const raw = await readFile(marker, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return raw.split("\n").filter(Boolean).map(JSON.parse);
}

async function withholdProjectHistory(fixture, chatId) {
  await fixture.sql([
    `CREATE FUNCTION fixture_withhold_project_history() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF TG_TABLE_NAME='native_history_turns' THEN
           IF NEW.status='completed' AND EXISTS (
             SELECT 1 FROM native_history_bindings WHERE id=NEW.binding_id AND chat_id=${literal(chatId)}
           ) THEN NEW.status := 'inProgress'; END IF;
         ELSIF NEW.chat_id=${literal(chatId)} AND NEW.component='assistant' AND NEW.state='completed' THEN
           NEW.state := 'unknown';
         END IF;
         RETURN NEW;
       END;
     $$`,
    `CREATE TRIGGER fixture_withhold_project_turn BEFORE INSERT OR UPDATE ON native_history_turns
       FOR EACH ROW EXECUTE FUNCTION fixture_withhold_project_history()`,
    `CREATE TRIGGER fixture_withhold_project_reply BEFORE INSERT OR UPDATE ON native_history_items
       FOR EACH ROW EXECUTE FUNCTION fixture_withhold_project_history()`,
  ]);
  return () =>
    fixture.sql([
      "DROP TRIGGER fixture_withhold_project_reply ON native_history_items",
      "DROP TRIGGER fixture_withhold_project_turn ON native_history_turns",
      "DROP FUNCTION fixture_withhold_project_history()",
    ]);
}

export async function actualCouncilProjectSteering({
  page,
  model,
  target,
  send,
  submit,
  idle,
  resultInputs,
  projectId,
  targetChatId,
  targetProfileId,
  steerRaceMarker,
  historyFault,
  result,
}) {
  const original = "Start the remote project turn for Council to steer.";
  const message = projectSteeringText;
  const firstAnswer = "The project Agent received the first prompt.";
  const answer = "The active project Agent incorporated Council's steer.";
  const read = () =>
    page.evaluate(
      async (id) => (await import("/src/lib/api/chats.ts")).getMessages(id),
      targetChatId,
    );
  const complete = (plan) =>
    eventually(
      () => plan.request?.completed,
      (done) => assert.equal(done, true),
      60_000,
    );
  const held = target.reply({ text: firstAnswer, hold: true });
  const continued = target.reply({ text: answer, hold: true });
  try {
    const root = await page.evaluate(
      async ({ targetChatId, targetProfileId, original }) =>
        (await import("/src/lib/api/chats.ts")).startTurn(
          targetChatId,
          original,
          {
            modelId: targetProfileId,
            reasoningEffort: null,
            customSubagentModel: false,
            subagentModelId: null,
            subagentReasoningEffort: null,
          },
        ),
      { targetChatId, targetProfileId, original },
    );
    assert.equal(root.status, "queued");
    await eventually(
      () => held.entered,
      (entered) => assert.equal(entered, true),
      60_000,
    );
    const args = {
      operationId: randomUUID(),
      projectId,
      chatId: targetChatId,
      steer: true,
      message,
    };
    const proposal = (responseId) =>
      model.reply({ responseId, calls: [{ ...send, arguments: args }] });
    proposal("council-steer-project-first");
    const duplicate = proposal("council-steer-project-retry");
    const done = model.reply({
      text: "I sent a steer to the active project Agent.",
    });
    assert.equal(
      (await submit("Steer the current project turn, then retry the delivery."))
        .status,
      "queued",
    );
    await complete(done);
    const receipt = projectToolOutput(
      duplicate,
      "council-steer-project-first-call-0",
    );
    assert.deepEqual(
      projectToolOutput(done, "council-steer-project-retry-call-0"),
      receipt,
    );
    if (steerRaceMarker) {
      await eventually(
        () => readTrace(steerRaceMarker),
        ([first]) => {
          assert.equal(first?.phase, "held");
          assert.equal(first.clientId, "cantrip:" + receipt.inputMessageId);
        },
        60_000,
      );
    } else {
      await eventually(
        read,
        (messages) => {
          const initial = messages.find(
            ({ role, content }) =>
              role === "user" && content.some(({ text }) => text === original),
          );
          const steering = messages.filter(
            ({ id, role }) => id === receipt.inputMessageId && role === "user",
          );
          assert.equal(steering.length, 1);
          assert.ok(initial?.executionLaneId);
          assert.equal(steering[0].executionLaneId, initial.executionLaneId);
          assert.ok(
            steering[0].content.some(
              ({ text, chatCommunication }) =>
                text === message && chatCommunication?.senderKind === "council",
            ),
          );
        },
        60_000,
      );
    }
    assert.equal(held.request.completed, false);
    await idle();

    const notice = model.reply({
      text: "I received the steered project turn's result.",
    });
    held.release();
    continued.release();
    await complete(continued);
    assert.ok(JSON.stringify(continued.request.input.input).includes(message));
    await complete(notice);
    assert.ok(JSON.stringify(notice.request.input.input).includes(answer));
    await idle();
    const matches = (await resultInputs()).filter(
      ({ source }) => source.inputMessageId === receipt.inputMessageId,
    );
    assert.equal(matches.length, 1);
    assert.equal(matches[0].source.chatId, targetChatId);
    assert.equal(matches[0].source.status, "completed");
    assert.ok(matches[0].source.turnId);
    if (steerRaceMarker) {
      const trace = await eventually(
        () => readTrace(steerRaceMarker),
        (rows) => assert.equal(rows.at(-1)?.phase, "started"),
        60_000,
      );
      const [intercept] = trace;
      const recoveredTurnId = matches[0].source.turnId;
      assert.notEqual(recoveredTurnId, intercept.turnId);
      assert.deepEqual(trace.slice(1), [
        { phase: "completed", turnId: intercept.turnId },
        {
          phase: "answered",
          error: { code: -32600, message: "no active turn to steer" },
        },
        { phase: "retried", clientId: intercept.clientId },
        { phase: "started", turnId: recoveredTurnId },
      ]);
      assert.equal(
        (await read()).filter(
          ({ id, role }) => id === receipt.inputMessageId && role === "user",
        ).length,
        1,
      );
      assert.deepEqual(model.failures, []);
      assert.deepEqual(target.failures, []);
      result.councilProjectSteeringRace = {
        receipt,
        source: matches[0].source,
        trace,
      };
      result.steps.push(
        "The remote Codex App Server rejected steering after its turn ended. The same protected input started once in a new native turn and returned one result to Council.",
      );
      return;
    }
    const fallbackMessage =
      "Deliver this later detail after the project became idle.";
    const fallbackAnswer =
      "The project handled the queued detail in a new turn.";
    const fallback = target.reply({ text: fallbackAnswer, hold: true });
    let restoreHistory;
    try {
      model.reply({
        responseId: "council-steer-project-fallback",
        calls: [
          {
            ...send,
            arguments: {
              ...args,
              operationId: randomUUID(),
              message: fallbackMessage,
            },
          },
        ],
      });
      const acknowledged = model.reply({
        text: "I queued the new detail for the project.",
      });
      await submit(
        "Steer the project with the new detail if a turn is still active.",
      );
      await complete(acknowledged);
      const idleReceipt = projectToolOutput(
        acknowledged,
        "council-steer-project-fallback-call-0",
      );
      await idle();
      const fallbackNotice = model.reply({
        text: "I received the result from the next project turn.",
      });
      if (historyFault) {
        restoreHistory = await withholdProjectHistory(
          historyFault,
          targetChatId,
        );
      }
      fallback.release();
      await complete(fallback);
      assert.ok(
        JSON.stringify(fallback.request.input.input).includes(fallbackMessage),
      );
      await complete(fallbackNotice);
      assert.ok(
        JSON.stringify(fallbackNotice.request.input.input).includes(
          fallbackAnswer,
        ),
      );
      await idle();
      const idleMatches = (await resultInputs()).filter(
        ({ source }) => source.inputMessageId === idleReceipt.inputMessageId,
      );
      assert.equal(idleMatches.length, 1);
      assert.equal(idleMatches[0].source.status, "completed");
      assert.notEqual(idleMatches[0].source.turnId, matches[0].source.turnId);
      if (historyFault) {
        const [evidence] = await historyFault.sql(
          [],
          [
            `SELECT jsonb_build_object(
              'canonicalDone',EXISTS(
                SELECT 1 FROM native_history_items WHERE chat_id=d.target_chat_id
                  AND thread_id=d.result_thread_id AND turn_id=d.result_turn_id
                  AND component='assistant' AND identity_kind='canonical' AND state='completed'),
              'historyDone', EXISTS(
                SELECT 1 FROM native_history_turns t JOIN native_history_bindings b ON b.id=t.binding_id
                WHERE b.chat_id=d.target_chat_id AND b.thread_id=d.result_thread_id
                  AND t.turn_id=d.result_turn_id AND t.status='completed'),
              'replyCleared',d.protected_reply IS NULL,'delivered',d.callback_delivered_at IS NOT NULL
            )::text FROM council_project_deliveries d WHERE d.input_message_id=${literal(idleReceipt.inputMessageId)}`,
          ],
        );
        assert.deepEqual(evidence, {
          canonicalDone: false,
          historyDone: false,
          replyCleared: true,
          delivered: true,
        });
        result.councilProjectReplyWithoutHistory = evidence;
      }
      result.councilProjectSteerFallback = {
        receipt: idleReceipt,
        source: idleMatches[0].source,
      };
    } finally {
      fallback.release();
      await restoreHistory?.();
    }
    assert.deepEqual(model.failures, []);
    assert.deepEqual(target.failures, []);
    result.councilProjectSteering = { receipt, source: matches[0].source };
    result.steps.push(
      "Council steered the remote project Agent's existing native lane while its first inference was held and received the result once. A later steer started a separate native turn when the project Agent was idle.",
    );
  } finally {
    held.release();
    continued.release();
  }
}
