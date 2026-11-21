import assert from "node:assert/strict";
import { modelFunctions } from "../server-rust/task-model-provider.mjs";
import { createPreparedProjectChat } from "./console-interaction-cases.mjs";

const admit = "/api/internal/native-commands/admit";
const fence = "/api/internal/native-commands/goal-recovery-fence";

export function goalClaimRecoveryCases() {
  const chats = new Map();
  const faults = {
    async blockRequest(url, bytes) {
      if (url !== admit && url !== fence) return false;
      const input = JSON.parse(bytes);
      const example =
        chats.get(input.session?.chatId) ??
        [...chats.values()].find(
          (entry) => entry.first?.operationId === input.admission?.operationId,
        );
      if (!example) return false;
      if (url === fence) {
        example.fence = input;
        return false;
      }
      if (input.method === "thread/goal/set") {
        example.setters.add(input.operationId);
      }
      if (!input.intent?.autonomousAttempt) return false;
      if (example.restarted) {
        // Queue-change delivery can wake the same producer before Core
        // sends claim recovery. Keep the claim unadmitted until that request.
        await example.deliverAdmission.promise;
        example.recovered = input;
        return false;
      }
      if (!example.first) example.first = input;
      return (
        !example.commitAdmission ||
        example.first.operationId !== input.operationId
      );
    },
    blockResponse(url, bytes, status) {
      if (url !== admit || status !== 200) return false;
      const input = JSON.parse(bytes);
      const example = chats.get(input.session?.chatId);
      if (
        !example?.commitAdmission ||
        example.restarted ||
        example.first?.operationId !== input.operationId
      )
        return false;
      example.admissionCommitted = true;
      return true;
    },
  };
  async function verify({
    call,
    eventually,
    createModel,
    encryptedTurn,
    ownerId,
    workerId,
    keyRevision,
    labelKey,
    startWorker,
    stopWorker,
    workerDiagnostics,
  }) {
    const { model, profile } = await createModel("Goal first-cycle recovery");
    await call("PATCH", "/api/settings", 200, {
      defaultModelId: profile.id,
      autoNameChats: false,
    });
    const modelCalls = () =>
      model.requests.filter(({ method }) => method === "POST").length;
    let workspaceId;
    for (const commitAdmission of [false, true]) {
      const title = commitAdmission
        ? "Goal with accepted child"
        : "Goal with no child";
      const {
        chatId,
        chatUrl,
        workspaceId: selectedWorkspace,
      } = await createPreparedProjectChat({
        call,
        eventually,
        ownerId,
        workerId,
        keyRevision,
        labelKey,
        title,
        workspaceId,
      });
      workspaceId = selectedWorkspace;
      const example = {
        commitAdmission,
        setters: new Set(),
        restarted: false,
        deliverAdmission: Promise.withResolvers(),
      };
      chats.set(chatId, example);
      const url = chatUrl + "/goal?encrypted=1";
      const before = modelCalls();
      const trigger = model.reply({ hold: true });
      const answer = model.reply({ text: title + " completed after restart." });
      try {
        const { queuedPrompt } = await encryptedTurn(
          title + " must resume the existing objective.",
          profile.id,
          "goal",
        );
        await call("POST", chatUrl + "/queue", 201, {
          ...queuedPrompt,
          executionMethod: "thread/goal/set",
        });
        await eventually(
          () => (commitAdmission ? example.admissionCommitted : example.first),
          (seen) => assert.ok(seen),
        );
        const first = example.first;
        assert.equal(example.setters.size, 1);
        assert.ok(first.goalQueueHandoff);
        const queue = await call("GET", chatUrl + "/queue", 200);
        const claimed = queue.claims.find(
          ({ id }) => id === first.goalQueueHandoff.claimId,
        );
        assert.equal(claimed.promptId, queuedPrompt.id);
        assert.equal(claimed.awaitingGoal, true);
        assert.equal(
          claimed.goalOperationId,
          commitAdmission ? first.operationId : null,
        );
        assert.equal(claimed.nativeTurnId, null);
        assert.equal(modelCalls(), before);
        assert.deepEqual(await stopWorker(), { code: 0, signal: null });
        example.restarted = true;
        await startWorker();
        await eventually(workerDiagnostics, (logs) =>
          assert.ok(
            /event=worker\.command\.dispatched operation=chat\.goal\.claim-recover /.test(
              logs,
            ),
            "Core did not dispatch the saved first-cycle claim.",
          ),
        );
        example.deliverAdmission.resolve();
        await eventually(
          () => trigger.request,
          (request) => assert.ok(request),
        );
        assert.equal(example.setters.size, 1);
        assert.ok(example.recovered);
        assert.notEqual(example.recovered.operationId, first.operationId);
        assert.notEqual(
          example.recovered.intent.workerGeneration,
          first.intent.workerGeneration,
        );
        assert.equal(
          example.recovered.session.threadId,
          first.session.threadId,
        );
        assert.deepEqual(
          example.recovered.goalQueueHandoff,
          first.goalQueueHandoff,
        );
        await eventually(workerDiagnostics, (logs) =>
          assert.ok(
            /event=worker\.command\.completed operation=chat\.goal\.claim-recover /.test(
              logs,
            ),
            "The worker did not acknowledge claim recovery.",
          ),
        );
        if (commitAdmission) {
          assert.equal(example.fence.admission.operationId, first.operationId);
          assert.equal(
            example.fence.admission.workerGeneration,
            first.intent.workerGeneration,
          );
          assert.equal(
            example.fence.firstClaim.claimId,
            first.goalQueueHandoff.claimId,
          );
          assert.deepEqual(
            example.recovered.intent.goalRecovery,
            example.fence.source,
          );
        } else {
          assert.equal(example.fence, undefined);
          assert.equal(example.recovered.intent.goalRecovery, undefined);
        }
        const tool = modelFunctions(trigger.request.input.tools).find(
          ({ name }) =>
            name === "update_goal" || name.endsWith("__update_goal"),
        );
        assert.ok(tool);
        trigger.calls = [{ ...tool, arguments: { status: "complete" } }];
        trigger.release();
        await eventually(
          () => answer.request,
          (request) => assert.equal(request?.completed, true),
        );
        await eventually(
          () => call("GET", url, 200),
          (value) => assert.equal(value.goal?.status, "complete"),
        );
        await eventually(
          () => call("GET", chatUrl + "/queue", 200),
          ({ claims, items }) => {
            assert.equal(
              claims.some(({ id }) => id === claimed.id),
              false,
            );
            assert.equal(
              items.some(({ id }) => id === queuedPrompt.id),
              false,
            );
          },
        );
        const messages = await call("GET", chatUrl + "/messages", 200);
        assert.equal(
          messages.messages.filter(
            ({ id }) => id === queuedPrompt.pendingMessage.id,
          ).length,
          1,
        );
        assert.equal(modelCalls(), before + 2);
        assert.deepEqual(model.failures, []);
        console.log(
          JSON.stringify({
            suite: "native-goal-claim-recovery",
            acceptedBeforeRestart: commitAdmission,
            passed: true,
          }),
        );
      } finally {
        example.deliverAdmission.resolve();
        trigger.release();
      }
    }
  }
  return { faults, verify };
}
