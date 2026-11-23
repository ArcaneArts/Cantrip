import assert from "node:assert/strict";
import { inferenceProgressUpdateSchema } from "../../packages/protocol/dist/index.js";
import { until } from "./native-settings-http-fixture.mjs";

export function dashboardInferenceProgress() {
  const emitted = [];
  return {
    emit(command, send) {
      const startedAt = new Date().toISOString();
      const progress = {
        kind: "progress",
        requestId: command.clientMessageId,
        cycle: 1,
        sequence: 1,
        phase: "prefill",
        fractionComplete: 0.25,
        completedTokens: 25,
        totalTokens: 100,
        precision: "exact",
        source: "provider-metrics",
        startedAt,
        observedAt: startedAt,
      };
      for (const input of [
        { ...progress, requestId: "unrelated-progress-request", sequence: 0 },
        progress,
        {
          ...progress,
          sequence: 2,
          phase: "generating",
          fractionComplete: 0.75,
          completedTokens: 75,
        },
        {
          kind: "clear",
          requestId: command.clientMessageId,
          cycle: 1,
          sequence: 3,
          observedAt: startedAt,
        },
      ]) {
        const value = inferenceProgressUpdateSchema.parse(input);
        emitted.push(structuredClone(value));
        send({ type: "agent.inference-progress", progress: value });
      }
    },
    async verify(h, result, command, chatId) {
      const events = () =>
        h.live.history.filter(
          (event) =>
            event.type === "event" && event.resource === "inference-progress",
        );
      await until(events, (values) => values.length >= 3);
      await h.live.ping("inference progress delivered while reply held");
      const actual = events();
      assert.equal(actual.length, 3, "unrelated request progress is ignored");
      const expected = emitted.filter(
        (value) => value.requestId === command.clientMessageId,
      );
      for (const [index, event] of actual.entries()) {
        assert.deepEqual(event.scope, { kind: "chat", chatId });
        assert.equal(event.entityId, command.clientMessageId);
        assert.equal(event.revision, expected[index].sequence);
        assert.equal(
          event.action,
          expected[index].kind === "clear" ? "deleted" : "updated",
        );
        assert.deepEqual(
          event.payload,
          expected[index].kind === "clear" ? null : expected[index],
        );
      }
      result.emittedInferenceProgress = structuredClone(emitted);
      result.rawInferenceProgressEvents = structuredClone(actual);
      result.inferenceProgressEvents = actual.map(({ cursor, ...event }) =>
        h.fixture.normalize(event),
      );
      result.inferenceProgressWhileReplyHeld = true;
    },
  };
}
