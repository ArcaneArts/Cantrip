import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  nativePermissionTransitionResolveSchema,
  nativeSettingsEvidenceSchema,
  nativeSettingsEvidenceResultSchema,
} from "../../packages/protocol/dist/index.js";
import {
  openNativeCommandContent,
  protectNativeCommandContent,
} from "../../tests/reference-node-worker/src/native-command-content.ts";

const method = "thread/settings/update";

export function consoleSettings({
  available,
  oracle,
  threadId,
  chatId,
  workerId,
  snapshot,
}) {
  const admitted = new Map();
  const supplied = randomUUID();
  const resolutions = [];
  let missingBindingAt;
  let profile = ":read-only";
  let policyRevision = 0;
  const cases = [
    { effort: "low", serviceTier: null },
    { effort: null, unsetServiceTier: true, operationId: supplied },
    { permissions: ":workspace", approvalPolicy: "on-request", effort: "low" },
    { permissions: ":workspace", approvalPolicy: "on-request" },
    { permissions: ":read-only" },
  ];
  const selection = (index) =>
    index === cases.length - 1 ? ":workspace" : cases[index].permissions;
  const open = async (direction, operationId, envelope, digest, eventId) => {
    const context = { chatId, operationId, direction, eventId };
    const args = { service: oracle, context };
    const content = await openNativeCommandContent({ ...args, envelope });
    const reference = await protectNativeCommandContent({ ...args, content });
    assert.equal(reference.digest, digest);
    return content;
  };

  return {
    resolve(value, send) {
      const input = nativePermissionTransitionResolveSchema.parse(value);
      const expected = cases[admitted.size].permissions;
      assert.equal(input.selectedId, selection(admitted.size));
      assert.equal(input.workerId, workerId);
      const peer = snapshot();
      const {
        workerId: _worker,
        bindingId,
        nativeEpoch: _epoch,
        ...session
      } = peer.binding;
      const { connectionId: _connection, ...resolved } = input.session;
      assert.deepEqual(resolved, session);
      if (missingBindingAt === undefined) {
        missingBindingAt = peer.refreshes;
        send({ code: "permission-binding-required" }, 409);
        return;
      }
      assert.ok(
        peer.refreshes > missingBindingAt,
        "Refresh the real bound snapshot before retrying",
      );
      const resolution = {
        bindingId,
        permissionTransition: {
          selectedId: input.selectedId,
          resolvedSelectedId: input.selectedId,
          effectiveId: expected,
          expectedRevision: String(policyRevision),
        },
      };
      resolutions.push(resolution);
      send(resolution);
    },

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
      const transition = expected.permissions ? resolutions.at(-1) : undefined;
      assert.equal(call.intent.permissionProfileId, profile);
      assert.deepEqual(
        call.intent.permissionTransition,
        transition?.permissionTransition,
      );
      assert.equal(call.intent.settingsBindingId, transition?.bindingId);
      assert.deepEqual(payload.params, {
        threadId,
        ...(transition
          ? {
              applyAt: "quiescent",
              approvalsReviewer: "user",
              approvalPolicy: "on-request",
            }
          : { sandboxPolicy: null, permissions: null, approvalPolicy: null }),
        ...expected,
        operationId: nativeOperationId,
      });
      assert.deepEqual(
        call.intent.settingKeys,
        Object.keys(payload.params).filter(
          (key) => !["threadId", "operationId", "applyAt"].includes(key),
        ),
      );
      admitted.set(call.operationId, {
        expected,
        nativeOperationId,
        mixed: Boolean(expected.permissions && expected.effort),
        queued: Promise.withResolvers(),
        applied: Promise.withResolvers(),
        rejected: Promise.withResolvers(),
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
      if (entry.mixed) {
        assert.equal(settlement.status, "rejected");
        assert.match(
          content.error.message,
          /quiescent updates accept security fields only/u,
        );
      } else {
        assert.equal(settlement.status, "applied", content.error?.message);
        assert.equal(content.result.operationId, entry.nativeOperationId);
        assert.ok(content.result.submissionId);
      }
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
      if (entry.mixed) {
        assert.equal(event.kind, "rejected");
        assert.equal(event.submissionId, null);
        assert.match(
          content.content.error.message,
          /quiescent updates accept security fields only/u,
        );
      } else if (event.kind === "queued") {
        assert.equal(
          content.content.result.operationId,
          entry.nativeOperationId,
        );
      } else {
        assert.equal(event.kind, "applied");
        assert.equal(content.content.operationId, entry.nativeOperationId);
        assert.equal(
          content.content.threadSettings.effort,
          entry.expected.effort ?? null,
        );
        assert.equal(
          content.content.threadSettings.serviceTier,
          entry.expected.unsetServiceTier || entry.expected.permissions
            ? null
            : "default",
        );
        if (entry.expected.permissions) {
          const { threadSettings, resolvedSecurity } = content.content;
          assert.equal(
            threadSettings.activePermissionProfile.id,
            entry.expected.permissions,
          );
          assert.deepEqual(content.permissionPolicy, event.permissionPolicy);
          assert.deepEqual(event.permissionPolicy, {
            effectiveId: entry.expected.permissions,
            settingsVersion: threadSettings.settingsVersion,
          });
          for (const field of [
            "approvalPolicy",
            "approvalsReviewer",
            "sandboxPolicy",
            "permissionProfile",
            "activePermissionProfile",
          ])
            assert.deepEqual(threadSettings[field], resolvedSecurity[field]);
          profile = entry.expected.permissions;
          policyRevision += 1;
        }
      }
      send(
        nativeSettingsEvidenceResultSchema.parse({
          operationId: event.operationId,
          operationGeneration: event.operationGeneration,
          eventId: event.eventId,
          application: {
            nativeOperationId: event.nativeOperationId,
            submissionId: event.submissionId,
            status: event.kind === "queued" ? "pending" : event.kind,
            evidenceCount: 1,
          },
          permissionPolicyPublished:
            event.kind === "applied" && Boolean(entry.expected.permissions),
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
        sandboxPolicy: { type: "dangerFullAccess" },
      });
      assert.match(
        rawPermission.error.message,
        /named managed permission profile/u,
      );
      const invalidPair = await call(method, {
        threadId,
        permissions: ":workspace",
        approvalPolicy: "never",
      });
      assert.match(invalidPair.error.message, /approval policy/u);
      assert.equal(admitted.size, 0);
      for (const [index, desired] of cases.entries()) {
        const frame = await call(method, {
          threadId,
          disabledPluginIds: null,
          sandboxPolicy: null,
          permissions: null,
          approvalPolicy: null,
          ...desired,
          ...(desired.permissions ? { permissions: selection(index) } : {}),
        });
        const entry = [...admitted.values()].at(-1);
        if (entry?.mixed) {
          assert.match(
            frame.error.message,
            /quiescent updates accept security fields only/u,
          );
          await available(entry.rejected.promise);
          const observed = await call("thread/settings/read", { threadId });
          assert.equal(
            observed.result.threadSettings.activePermissionProfile.id,
            profile,
          );
          assert.equal(observed.result.threadSettings.effort, null);
          continue;
        }
        assert.ok(!frame.error, JSON.stringify(frame.error));
        assert.equal(frame.result.operationId, entry.nativeOperationId);
        for (const evidence of [entry.queued, entry.applied]) {
          assert.equal(
            await available(evidence.promise),
            frame.result.submissionId,
          );
        }
        const observed = await call("thread/settings/read", { threadId });
        assert.equal(
          observed.result.threadSettings.effort,
          desired.effort ?? null,
        );
        assert.equal(
          observed.result.threadSettings.serviceTier,
          desired.unsetServiceTier || desired.permissions ? null : "default",
        );
        if (desired.permissions)
          assert.equal(
            observed.result.threadSettings.activePermissionProfile.id,
            desired.permissions,
          );
      }
      assert.equal(admitted.size, cases.length);
      assert.equal(resolutions.length, 3);
      console.log(
        "Managed console settings and permission choices matched Core admission, native readback and protected evidence.",
      );
    },
  };
}
