import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  nativeSettingsEvidenceSchema,
  nativeSettingsEvidenceResultSchema,
} from "../../packages/protocol/dist/index.js";
import {
  openNativeCommandContent,
  protectNativeCommandContent,
} from "../../cantrip_worker/src/native-command-content.ts";

const method = "thread/settings/update";

export function consoleSettings({ available, oracle, threadId, chatId }) {
  const admitted = new Map();
  const supplied = randomUUID();
  const cases = [
    { effort: "low", serviceTier: null },
    { effort: null, unsetServiceTier: true, operationId: supplied },
  ];
  const open = async (direction, operationId, envelope, digest, eventId) => {
    const context = { chatId, operationId, direction, eventId };
    const args = { service: oracle, context };
    const content = await openNativeCommandContent({ ...args, envelope });
    const reference = await protectNativeCommandContent({ ...args, content });
    assert.equal(reference.digest, digest);
    return content;
  };

  return {
    async admit(call, payload) {
      const expected = cases[admitted.size];
      assert.ok(expected, "Unexpected console settings admission");
      const nativeOperationId = expected.operationId ?? call.operationId;
      assert.equal(call.intent.nativeSettingsOperationId, nativeOperationId);
      assert.equal(call.intent.pathsWithinPlacement, true);
      assert.equal(call.intent.expectedTurnId, null);
      assert.deepEqual(
        await open(
          "request",
          call.operationId,
          call.protectedPayload,
          call.payloadDigest,
        ),
        payload,
      );
      assert.deepEqual(payload.params, {
        threadId,
        sandboxPolicy: null,
        permissions: null,
        approvalPolicy: null,
        ...expected,
        operationId: nativeOperationId,
      });
      assert.deepEqual(
        call.intent.settingKeys,
        Object.keys(payload.params).filter(
          (key) => key !== "threadId" && key !== "operationId",
        ),
      );
      admitted.set(call.operationId, {
        expected,
        nativeOperationId,
        queued: Promise.withResolvers(),
        applied: Promise.withResolvers(),
      });
    },

    async settle(settlement, content) {
      const entry = admitted.get(settlement.operationId);
      assert.ok(entry);
      assert.deepEqual(
        await open(
          "result",
          settlement.operationId,
          settlement.protectedResult,
          settlement.resultDigest,
        ),
        content,
      );
      assert.equal(content.result.operationId, entry.nativeOperationId);
      assert.ok(content.result.submissionId);
    },

    async evidence(input, receipt, send) {
      const event = nativeSettingsEvidenceSchema.parse(input);
      const entry = admitted.get(event.operationId);
      assert.ok(entry);
      assert.equal(event.operationGeneration, receipt.operationGeneration);
      assert.equal(event.threadId, threadId);
      assert.equal(event.nativeOperationId, entry.nativeOperationId);
      const content = await open(
        "settings-evidence",
        event.operationId,
        event.protectedResult,
        event.resultDigest,
        event.eventId,
      );
      assert.equal(content.kind, event.kind);
      assert.equal(content.submissionId, event.submissionId);
      assert.equal(content.scope.nativeOperationId, entry.nativeOperationId);
      assert.equal(content.scope.operationId, receipt.operationId);
      if (event.kind === "queued") {
        assert.equal(
          content.content.result.operationId,
          entry.nativeOperationId,
        );
      } else {
        assert.equal(event.kind, "applied");
        assert.equal(content.content.operationId, entry.nativeOperationId);
        assert.equal(
          content.content.threadSettings.effort,
          entry.expected.effort,
        );
        assert.equal(
          content.content.threadSettings.serviceTier,
          entry.expected.unsetServiceTier ? null : "default",
        );
      }
      send(
        nativeSettingsEvidenceResultSchema.parse({
          operationId: event.operationId,
          operationGeneration: event.operationGeneration,
          eventId: event.eventId,
          application: {
            nativeOperationId: event.nativeOperationId,
            submissionId: event.submissionId,
            status: event.kind === "applied" ? "applied" : "pending",
            evidenceCount: 1,
          },
        }),
      );
      entry[event.kind].resolve(event.submissionId);
    },

    async verify(call) {
      const wrongThread = await call(method, {
        threadId: "another-thread",
        effort: "low",
      });
      assert.ok(wrongThread.error);
      const wrongPlace = await call(method, {
        threadId,
        cwd: "/",
        effort: "low",
      });
      assert.ok(
        wrongPlace.error,
        "Settings must remain in the admitted guest workspace.",
      );
      const rawPermission = await call(method, {
        threadId,
        permissions: ":danger-full-access",
      });
      assert.match(
        rawPermission.error.message,
        /managed permission transition/u,
      );
      assert.equal(admitted.size, 0);
      for (const desired of cases) {
        const frame = await call(method, {
          threadId,
          disabledPluginIds: null,
          sandboxPolicy: null,
          permissions: null,
          approvalPolicy: null,
          ...desired,
        });
        assert.ok(!frame.error, JSON.stringify(frame.error));
        const entry = [...admitted.values()].at(-1);
        assert.equal(frame.result.operationId, entry.nativeOperationId);
        for (const evidence of [entry.queued, entry.applied]) {
          assert.equal(
            await available(evidence.promise),
            frame.result.submissionId,
          );
        }
        const observed = await call("thread/settings/read", { threadId });
        assert.equal(observed.result.threadSettings.effort, desired.effort);
        assert.equal(
          observed.result.threadSettings.serviceTier,
          desired.unsetServiceTier ? null : "default",
        );
      }
      assert.equal(admitted.size, cases.length);
      console.log(
        "Managed console settings matched the native reply and applied evidence, including an explicit cleared effort.",
      );
    },
  };
}
