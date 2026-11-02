// Production HTTP receipts and durable notifications through the unchanged
// worker transport. Runtime execution is controlled; this is not full app QA.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import { command } from "./native-command-admission-cases.mjs";
import { literal } from "./project-target-state.mjs";
import {
  seedEventChats,
  rejectedEventCredentials,
} from "./native-event-http-setup.mjs";
import { scrubEventContent } from "./native-event-http-content.mjs";
import { protectChatMessage } from "../../cantrip_worker/src/chat-message-encryption.ts";
import { decryptChatMessageProtectedContent } from "../../packages/crypto/dist/index.js";
import {
  nativeCommandDispatchSchema,
  nativeCommandSettlementSchema,
} from "../../packages/protocol/dist/index.js";
import {
  settingsHttpFixture,
  settingsChat as chat,
  settingsWorker as worker,
  settingsProject as project,
  settingsTree as tree,
  componentKey,
} from "./native-settings-http-fixture.mjs";

const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-native-execution-http-"),
);
const report = {
  suite: "production-native-receipts-and-outcomes-http",
  databaseMode,
  completeReplacement: false,
  actualFullWorkerRuntime: false,
  profiles: [],
};
const privateMarker = "private-execution-outcome-http";
function assertReplay(previous, current) {
  const before = Date.parse(previous.receipt.updatedAt);
  const after = Date.parse(current.receipt.updatedAt);
  assert.ok(Number.isFinite(before) && Number.isFinite(after));
  assert.ok(after >= before && after <= Date.now() + 1000);
  // Source persists a fresh update clock on settlement replay. Every other
  // receipt field, including the original creation clock, stays identical.
  assert.deepEqual(
    {
      ...current,
      receipt: { ...current.receipt, updatedAt: previous.receipt.updatedAt },
    },
    previous,
  );
}
let pg, active, failure;
try {
  const executable = await buildRustServer();
  const repositoryExecutable = await buildRustExample(
    "project-repository-fixture",
  );
  const passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !option("--profile") || option("--profile") === p,
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const result = {
        kind,
        observations: [],
        snapshotProofs: 0,
        receiptEvents: [],
        outcomeCryptoProofs: 0,
      };
      outputs.push(result);
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const h = (active = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        repositoryExecutable,
        databaseMode,
        url,
        passwordHash,
        result,
        configure: seedEventChats,
        onCommand: async (command, _emit, { encryption }) => {
          if (command.type === "chat.message.protect")
            return protectChatMessage({
              id: command.message.id,
              message: command.message,
              service: encryption,
            });
        },
      }));
      const processHandle = h.fixture.server;
      const endpoint = "/api/internal/native-commands/receipt";
      const auth = {
        client: "worker",
        headers: { authorization: "Bearer " + h.credential },
      };
      const session = {
        chatId: chat,
        threadId: "thread",
        contextKind: "project",
        projectId: project,
        placementId: tree,
        modelRouteId: null,
        providerAccountId: null,
        runtimeGeneration: "runtime",
        connectionId: "connection",
      };
      const admit = async (name, method, intent = {}) => {
        const input = command({
          workerId: worker,
          operationId: "http-" + name,
          origin: "terminal",
          session,
          method,
          intent,
        });
        const admitted = await h.visit(
          name + " admission",
          "POST",
          "/api/internal/native-commands/admit",
          { ...auth, json: input },
        );
        assert.equal(admitted.receipt.status, "accepted");
        const dispatch = nativeCommandDispatchSchema.parse({
          workerId: worker,
          operationId: input.operationId,
          operationGeneration: admitted.receipt.operationGeneration,
          payloadDigest: input.payloadDigest,
          session,
        });
        await h.visit(
          name + " dispatch",
          "POST",
          "/api/internal/native-commands/dispatch",
          { ...auth, json: dispatch },
        );
        return { admitted, dispatch };
      };
      const settle = (dispatch, fields = {}) =>
        nativeCommandSettlementSchema.parse({
          workerId: worker,
          operationId: dispatch.operationId,
          operationGeneration: dispatch.operationGeneration,
          status: "applied",
          resultDigest: null,
          protectedResult: null,
          rejectionCode: null,
          ...fields,
        });
      const publishReceipt = async (name, input, expectedResources) => {
        // Drain publications from the preceding admission/dispatch before
        // attributing subsequent Live frames to this receipt request.
        await h.live.ping(name + " before");
        const before = h.live.history.filter((e) => e.type === "event").length;
        const response = await h.visit(name, "POST", endpoint, {
          ...auth,
          json: input,
        });
        await h.live.ping(name);
        const events = h.live.history
          .filter((e) => e.type === "event")
          .slice(before);
        assert.deepEqual(
          events.map((e) => e.resource),
          expectedResources,
          name + " Live effects",
        );
        result.receiptEvents.push({
          name,
          events: events.map(
            ({ scope, resource, action, entityId, revision, payload }) => ({
              scope,
              resource,
              action,
              entityId,
              revision,
              payload,
            }),
          ),
        });
        return response;
      };
      try {
        await h.visit(
          "receipt validates before authentication",
          "POST",
          endpoint,
          { client: "worker", json: {}, status: 400 },
        );
        const first = await admit("ordinary", "hooks/list");
        const input = settle(first.dispatch);
        await h.visit("receipt requires credentials", "POST", endpoint, {
          client: "worker",
          json: input,
          status: 401,
        });
        for (const credential of rejectedEventCredentials)
          await h.visit(
            "receipt rejects " + credential.reason,
            "POST",
            endpoint,
            {
              ...auth,
              headers: { authorization: "Bearer " + credential.credential },
              json: input,
              status: 401,
            },
          );
        await h.visit("receipt rejects stale generation", "POST", endpoint, {
          ...auth,
          json: { ...input, operationGeneration: "missing" },
          status: 404,
        });
        const applied = await publishReceipt("ordinary receipt", input, []);
        assert.equal(applied.receipt.status, "applied");
        assertReplay(
          applied,
          await publishReceipt("ordinary receipt replay", input, []),
        );
        for (const status of ["applied", "rejected"]) {
          const { dispatch } = await admit(
            "settings-" + status,
            "thread/settings/update",
          );
          const body = await publishReceipt(
            "settings " + status,
            settle(dispatch, {
              status,
              rejectionCode:
                status === "rejected" ? "controlled-rejection" : null,
            }),
            ["chat"],
          );
          assert.equal(body.receipt.status, status);
        }
        const terminal = await admit("terminal", "turn/start");
        const completed = settle(terminal.dispatch, {
          executionComplete: true,
          executionStatus: "idle",
        });
        const receipt = await publishReceipt(
          "terminal execution completes",
          completed,
          ["chat", "chat-goal", "chat-plan"],
        );
        assert.equal(receipt.receipt.status, "applied");
        assertReplay(
          receipt,
          await publishReceipt("terminal completion replay", completed, [
            "chat",
            "chat-goal",
            "chat-plan",
          ]),
        );

        const saved = await admit("durable-outcome", "turn/start");
        const note = {
          type: "chat.turn.outcome",
          chatId: chat,
          clientMessageId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          executionLaneId: saved.admitted.receipt.executionLaneId,
          contextKind: "project",
          worktreeId: tree,
          scratchRootId: null,
          outcome: {
            ok: true,
            result: {
              threadId: "thread",
              turnId: "outcome-http-turn",
              status: "completed",
              text: privateMarker,
            },
          },
        };
        assert.equal(h.worker.sendNotification(note), true);
        let messages;
        const deadline = Date.now() + 15000;
        do {
          await delay(50);
          await h.fixture.observe(
            "outcome poll",
            "GET",
            `/api/chats/${chat}/messages`,
          );
          messages = h.fixture.records.get("outcome poll").messages;
        } while (messages.length === 0 && Date.now() < deadline);
        assert.equal(
          messages.length,
          1,
          "actual production notification recovery",
        );
        const message = messages[0];
        assert.equal(
          message.idempotencyKey,
          "assistant:" + note.clientMessageId,
        );
        const opened = await decryptChatMessageProtectedContent({
          ownerId: h.owner,
          messageId: message.id,
          keyRevision: 1,
          componentKey: new Uint8Array(componentKey),
          encrypted: message.protectedContent,
          publicClassification: {
            role: message.role,
            mode: message.mode,
            attachmentIds: message.attachmentIds,
          },
        });
        assert.deepEqual(opened.content, [
          { type: "text", text: privateMarker, phase: "final_answer" },
        ]);
        result.outcomeCryptoProofs++;
        assert.equal(JSON.stringify(messages).includes(privateMarker), false);
        assert.equal(h.worker.sendNotification(note), true);
        await delay(1200);
        const duplicate = await h.visit(
          "outcome replay messages",
          "GET",
          `/api/chats/${chat}/messages`,
        );
        assert.equal(duplicate.messages.length, 1);
        await h.visit("settle recovered native operation", "POST", endpoint, {
          ...auth,
          json: settle(saved.dispatch, {
            executionComplete: true,
            executionStatus: "idle",
          }),
        });
      } finally {
        await h.close();
        active = null;
      }
      const repository = await repositoryFixture({
        kind,
        executable: repositoryExecutable,
        root: path.join(root, profile),
        databaseMode,
        databaseUrl: url,
      });
      try {
        const stored = await repository.request({
          op: "query-json",
          sql: `SELECT jsonb_build_object('status',(SELECT status FROM chats WHERE id=${literal(chat)}),'messages',(SELECT count(*) FROM chat_messages WHERE chat_id=${literal(chat)}),'activeLanes',(SELECT count(*) FROM chat_execution_lanes WHERE chat_id=${literal(chat)} AND state='active'),'receipts',(SELECT count(*) FROM native_commands WHERE chat_id=${literal(chat)} AND status IN ('applied','rejected'))) result`,
        });
        assert.equal(stored.rejected, false, stored.diagnostic);
        assert.deepEqual(stored.value, {
          status: "idle",
          messages: 1,
          activeLanes: 0,
          receipts: 5,
        });
        result.durableState = stored.value;
      } finally {
        await repository.close();
      }
      result.observations = scrubEventContent(result.observations);
      result.diagnostics = processHandle.diagnostics();
      assert.equal(
        result.diagnostics.includes(privateMarker),
        false,
        "outcome logs do not disclose result text",
      );
    }
    for (const field of [
      "observations",
      "receiptEvents",
      "outcomeCryptoProofs",
      "durableState",
    ])
      assert.deepEqual(
        outputs[1][field],
        outputs[0][field],
        profile + " " + field,
      );
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.retainedRoot = root;
  report.diagnostics = active?.diagnostics();
} finally {
  await active?.close().catch(() => {});
  await pg?.close();
  if (option("--report")) {
    const file = path.resolve(option("--report"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    passed: true,
    databaseMode,
    profiles: report.profiles.length,
  }),
);
