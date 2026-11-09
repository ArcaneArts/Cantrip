// Real worker encryption and MCP logic through paired HTTP and owning databases.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import {
  settingsHttpFixture,
  settingsChat as chat,
  settingsProject as project,
  settingsTree as tree,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import { literal, json } from "./project-target-state.mjs";
import { encodePrivateDisplayLabelForWorker } from "../../cantrip_worker/src/private-label-encryption.ts";
import { executeCantripMcpChatOperation } from "../../cantrip_worker/src/mcp/chat-operations.ts";
import { openEncryptedChatTurn } from "../../cantrip_worker/src/chat-message-encryption.ts";
import { runAgentChatSendCases } from "./agent-chat-send-http-cases.mjs";
import { deliveryLifecycle } from "./agent-chat-send-http-lifecycle.mjs";
import { chatMessageOpaqueContentSchema } from "../../packages/protocol/dist/index.js";
const deliveryQueries = JSON.parse(
  await readFile(
    new URL(
      "../../cantrip_server_rs/contracts/mcp-delivery-queries.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const executable =
  process.env.CANTRIP_RUST_SERVER_BINARY ??
  (await buildRustExample("http-sql-fixture"));
const reportPath =
  option("--report") ?? `.qa/rust-server/mcp-chat-send-${databaseMode}.json`;
const root = await mkdtemp(path.join(tmpdir(), "cantrip-mcp-delivery-matrix-"));
const target = "44444444-4444-4444-8444-444444444444";
const id = (n) => `55555555-5555-4555-8555-${String(n).padStart(12, "0")}`;
const marker = (n) => `PRIVATE_AGENT_DELIVERY_${n}`;
const report = {
  root,
  executable,
  databaseMode,
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  actualHttp: true,
  actualWorkerConnection: true,
  actualWorkerMcpAndEncryption: true,
  fullWorkerProcess: false,
  completeReplacement: false,
  profiles: [],
};
let h, pg, failure;
try {
  const passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !option("--profile") || p === option("--profile"),
  )) {
    const p = { profile, peers: [], differences: [], auditDifferences: [] };
    report.profiles.push(p);
    for (const kind of ["node", "rust"]) {
      const result = {
        kind,
        observations: [],
        commands: [],
        calls: [],
        workerResults: [],
        proofs: [],
      };
      p.peers.push(result);
      h = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        databaseMode,
        passwordHash,
        result,
        liveSqlFixture: true,
        url:
          pg && (kind === "node" || databaseMode === "postgres")
            ? await pg.database()
            : undefined,
        onCommand: async (command) => {
          result.commands.push(command.type);
        },
      });
      try {
        const sql = (statements = [], queries = []) =>
          h.fixture.sql(statements, queries);
        const title = async (rowId, label) =>
          encodePrivateDisplayLabelForWorker({
            ownerId: h.owner,
            rowId,
            label,
            recordKind: "chat",
            service: h.encryption,
          });
        await sql([
          `INSERT INTO model_profiles(id,owner_id,name) VALUES('mcp-default',${literal(h.owner)},'MCP default'),('mcp-receiver',${literal(h.owner)},'MCP receiver'),('mcp-subagent',${literal(h.owner)},'MCP subagent')`,
          `UPDATE user_settings SET default_model_id='mcp-default' WHERE user_id=${literal(h.owner)}`,
          `UPDATE chats SET status='running',permission_profile_id=':workspace',protected_label=${json(await title(chat, "Sender"))} WHERE id=${literal(chat)}`,
          `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES('mcp-delivery-lane',${literal(chat)},${literal(tree)},${literal(worker)},'agent',false,'Qualification','active',now(),'settings-runtime')`,
          `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,experience,automation_paused,model_id,reasoning_effort,custom_subagent_model,subagent_model_id,subagent_reasoning_effort,permission_profile_id) VALUES(${literal(target)},${literal(h.owner)},${literal(project)},${literal(tree)},${literal(worker)},${json(await title(target, "Receiver"))},'agent',true,'mcp-receiver','medium',true,'mcp-subagent','low',':read-only')`,
        ]);
        await h.live.subscribed("delivery-chat-events", [
          { kind: "chat", chatId: chat },
          { kind: "chat", chatId: target },
        ]);
        const binding = {
          bindingId: id(900),
          ownerId: h.owner,
          contextKind: "project",
          projectId: project,
          chatId: chat,
          executionLaneId: "mcp-delivery-lane",
          workerId: worker,
          worktreeId: tree,
          rootKind: "git-worktree",
          scratchRootId: null,
          permissionProfileId: ":workspace",
          allowedOperations: ["context.get", "chat.read", "chat.send"],
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 120000).toISOString(),
        };
        const wire = new Map();
        const wireAttempts = new Map();
        async function call(
          name,
          operation,
          args,
          status = 200,
          claims = binding,
        ) {
          const response = await fetch(
            h.fixture.server.origin + "/api/internal/agent-operations",
            {
              method: "POST",
              headers: {
                authorization: "Bearer " + h.credential,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                requestId: randomUUID(),
                binding: claims,
                request: { operation, arguments: args },
              }),
              signal: AbortSignal.timeout(15000),
            },
          );
          const body = await response.json();
          assert.equal(
            JSON.stringify({ args, body }).includes("PRIVATE_AGENT_DELIVERY_"),
            false,
            "Server relay retains ciphertext only",
          );
          const row = {
            name,
            operation,
            args,
            status: response.status,
            body,
            httpRequestId: response.headers.get("x-request-id"),
            bindingId: claims.bindingId,
          };
          result.calls.push(row);
          if (
            name === "actual outgoing message insert failure" &&
            body.error?.startsWith("Failed query:")
          ) {
            const message = chatMessageOpaqueContentSchema.parse(
              args.sentMessage,
            );
            const fields = {
              id: message.id,
              chat_id: claims.chatId,
              worktree_id: tree,
              scratch_root_id: null,
              execution_lane_id: claims.executionLaneId,
              role: message.classification.role,
              mode: message.classification.mode,
              content: null,
              protected_content: message.protectedContent,
              attachment_ids: message.classification.attachmentIds,
              task_protected_content: null,
              reasoning_effort: message.reasoningEffort,
              idempotency_key: message.idempotencyKey,
            };
            const parameters = deliveryQueries.insert.parameters.map((p) => {
              assert.ok(Object.hasOwn(fields, p.column));
              const value = fields[p.column];
              return value === null
                ? null
                : p.json
                  ? JSON.stringify(value)
                  : value;
            });
            const expected = (
              "Failed query: " +
              deliveryQueries.insert.sql +
              "\nparams: " +
              parameters.map((v) => v ?? "").join(",")
            ).slice(0, 2000);
            assert.equal(
              body.error,
              expected,
              "Whole Source INSERT SQL, request-bound encrypted parameters and UTF-16 limit match",
            );
            row.sourceInsertFailureVerified = {
              sql: deliveryQueries.insert.sql,
              parameters,
              utf16Limit: 2000,
            };
            row.comparisonBody = {
              ...body,
              error:
                "<verified Source message INSERT SQL and exact request-bound parameters; UTF16 limit 2000>",
            };
          }
          if (kind === "node")
            assert.equal(
              response.status,
              status,
              JSON.stringify({ name, body }),
            );
          return row;
        }
        async function invoke(
          name,
          n,
          { claims = binding, receiver = target, prepare = false } = {},
        ) {
          let prepared;
          const value = await executeCantripMcpChatOperation({
            binding: claims,
            service: h.encryption,
            requestId: randomUUID(),
            request: {
              operation: "chat.send",
              arguments: {
                chatId: receiver,
                operationId: id(n),
                message: marker(n),
              },
            },
            execute: async (_binding, request) => {
              if (request.operation === "chat.send") {
                prepared = request.arguments;
                wire.set(n, structuredClone(prepared));
                if (!wireAttempts.has(n)) wireAttempts.set(n, []);
                wireAttempts.get(n).push(structuredClone(prepared));
                if (prepare)
                  return {
                    summary: "Prepared encrypted input.",
                    data: {},
                    mutated: false,
                    target: null,
                    worktreeId: tree,
                    continuationScheduled: false,
                  };
              }
              const observed = await call(
                name + " " + request.operation,
                request.operation,
                request.arguments,
                200,
                claims,
              );
              if (observed.status !== 200)
                throw new Error(JSON.stringify(observed.body));
              return observed.body;
            },
          });
          assert.equal(value.data.message, marker(n));
          assert.equal(
            value.data.sourceTitle,
            claims.chatId === chat ? "Sender" : "Receiver",
          );
          assert.equal(
            value.data.targetTitle,
            receiver === target ? "Receiver" : "Sender",
          );
          if (!prepare) {
            assert.equal(value.mutated, true);
            result.workerResults.push({ name, value });
          }
          return prepare ? prepared : value;
        }
        async function state() {
          const [value] = await sql(
            [],
            [
              `SELECT jsonb_build_object('queue',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM queued_prompts p WHERE p.chat_id IN (${literal(chat)},${literal(target)})),'[]'::jsonb),'messages',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM chat_messages m WHERE m.chat_id IN (${literal(chat)},${literal(target)})),'[]'::jsonb),'commands',coalesce((SELECT jsonb_agg(to_jsonb(n) ORDER BY n.operation_id) FROM native_commands n WHERE n.owner_id=${literal(h.owner)} AND n.method='thread/queue/add'),'[]'::jsonb),'queueStates',coalesce((SELECT jsonb_agg(jsonb_build_object('chat_id',q.chat_id,'revision',q.revision) ORDER BY q.chat_id) FROM managed_queue_states q WHERE q.chat_id IN (${literal(chat)},${literal(target)})),'[]'::jsonb),'paused',(SELECT automation_paused FROM chats WHERE id=${literal(target)}))::text result`,
            ],
          );
          assert.equal(
            JSON.stringify(value).includes("PRIVATE_AGENT_DELIVERY_"),
            false,
            "Database rows remain opaque",
          );
          return value;
        }
        async function unchanged(name, run) {
          const before = await state();
          await run();
          assert.deepEqual(
            await state(),
            before,
            name + " preserves all delivery rows",
          );
        }
        async function prove(n) {
          const current = await state(),
            attempts = wireAttempts.get(n);
          assert.ok(attempts?.length);
          const queued = current.queue.find(
            (q) => q.id === attempts[0].turn.queuedPrompt.id,
          );
          assert.ok(queued);
          const accepted = attempts.filter(
            (args) =>
              isDeepStrictEqual(
                queued.opaque_content.protectedContent,
                args.turn.queuedPrompt.protectedContent,
              ) &&
              isDeepStrictEqual(
                queued.opaque_content.pendingMessage.protectedContent,
                args.turn.message.protectedContent,
              ),
          );
          assert.equal(
            accepted.length,
            1,
            "The committed queue retains one actual request's paired encrypted envelopes",
          );
          const args = accepted[0];
          result.ownedCipherProofs ??= [];
          result.ownedCipherProofs.push({
            operationId: id(n),
            submittedCandidates: attempts.length,
            exactCommittedCandidate: attempts.indexOf(args),
          });
          assert.deepEqual(
            queued.opaque_content.protectedContent,
            args.turn.queuedPrompt.protectedContent,
          );
          assert.deepEqual(
            queued.opaque_content.pendingMessage.protectedContent,
            args.turn.message.protectedContent,
          );
          const opened = await openEncryptedChatTurn({
            history: [],
            prompt: queued.opaque_content.pendingMessage,
            service: h.encryption,
            threadId: "recipient-thread",
          });
          assert.ok(opened.includes(marker(n)));
          assert.ok(opened.includes("another agent, not the human user"));
          const command = current.commands.find(
            (c) =>
              c.operation_id === `agent-chat:queue:${chat}:${target}:${id(n)}`,
          );
          assert.ok(command);
          assert.equal(Object.hasOwn(command.intent, "resumeAutonomy"), false);
          result.proofs.push({
            operationId: id(n),
            queueId: queued.id,
            modelId: queued.model_id,
            reasoningEffort: queued.reasoning_effort,
            customSubagentModel: queued.custom_subagent_model,
            subagentModelId: queued.subagent_model_id,
            subagentReasoningEffort: queued.subagent_reasoning_effort,
            paused: current.paused,
          });
        }
        const lifecycle = deliveryLifecycle({
          h,
          binding,
          result,
          state,
          call,
          target,
          chat,
          marker,
          wire,
          id,
        });
        await runAgentChatSendCases({
          h,
          result,
          kind,
          binding,
          target,
          chat,
          project,
          tree,
          worker,
          id,
          marker,
          wire,
          sql,
          call,
          invoke,
          state,
          unchanged,
          prove,
          ...lifecycle,
        });
        const [audit] = await sql(
          [],
          [
            "SELECT jsonb_build_object('events',coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM audit_events a WHERE a.action LIKE 'mcp.operation.%'),'[]'::jsonb))::text result",
          ],
        );
        const byRequest = new Map(
          result.calls.map((c) => [c.httpRequestId, c]),
        );
        assert.equal(audit.events.length, result.calls.length);
        result.auditEvents = audit.events.map((event) => {
          const call = byRequest.get(event.request_id);
          assert.ok(call);
          assert.equal(event.owner_id, h.owner);
          assert.equal(event.actor_user_id, null);
          assert.equal(event.actor_session_id, null);
          assert.equal(event.resource_type, "mcp-binding");
          assert.equal(event.resource_id, call.bindingId);
          assert.equal(
            event.action,
            call.status === 200
              ? call.operation === "chat.send"
                ? "mcp.operation.mutated"
                : "mcp.operation.executed"
              : "mcp.operation.rejected",
          );
          assert.equal(
            event.result,
            call.status === 200
              ? "succeeded"
              : ["forbidden", "stale-binding", "expired"].includes(
                    call.body.code,
                  )
                ? "denied"
                : "failed",
          );
          return {
            name: call.name,
            action: event.action,
            result: event.result,
          };
        });
        await h.live.ping("delivery event barrier");
        result.events = [
          ...(result.eventsBeforeRestart ?? []),
          ...h.live.frames.filter(
            (frame) =>
              frame.type === "event" && frame.resource === "chat-message",
          ),
        ];
        assert.equal(
          result.events.length,
          result.calls.filter(
            (c) => c.operation === "chat.send" && c.status === 200,
          ).length * 2,
          "Only successful committed deliveries publish the two history events, including replays",
        );
        result.finalState = await state();
      } finally {
        result.serverDiagnostics = h.diagnostics();
        await h.live?.close();
        await h.close();
        h = undefined;
      }
    }
    const [source, native] = p.peers;
    const concurrencyGroup = (name) =>
      name.match(/^(duplicate(?:-initial)?|reverse)-[ab]/)?.[1];
    const concurrentAudits = (events) => {
      const output = [];
      for (let i = 0; i < events.length;) {
        const group = concurrencyGroup(events[i].name);
        if (!group) {
          output.push(events[i++]);
          continue;
        }
        let end = i + 1;
        while (
          end < events.length &&
          concurrencyGroup(events[end].name) === group
        )
          end++;
        // Preserve named outcomes and sequential barriers; independent requests
        // have no promised ordering inside one concurrent phase.
        output.push(
          ...events.slice(i, end).sort((a, b) => a.name.localeCompare(b.name)),
        );
        i = end;
      }
      return output;
    };
    for (const field of [
      "workerResults",
      "proofs",
      "auditEvents",
      "decryptedReads",
    ]) {
      const canonical = (value) =>
        field === "workerResults"
          ? [...value].sort((a, b) => a.name.localeCompare(b.name))
          : field === "auditEvents"
            ? concurrentAudits(value)
            : field === "decryptedReads"
              ? value.map(({ name, receiver, comparisonMessages }) => ({
                  name,
                  receiver,
                  messages: comparisonMessages,
                }))
              : value;
      if (
        JSON.stringify(canonical(source[field])) !==
        JSON.stringify(canonical(native[field]))
      )
        p.auditDifferences.push({
          field,
          node: source[field],
          rust: native[field],
        });
    }
    const a = source.calls.filter(
        (c) => c.operation !== "chat.read" || c.status !== 200,
      ),
      b = native.calls.filter(
        (c) => c.operation !== "chat.read" || c.status !== 200,
      );
    assert.equal(a.length, b.length);
    const nativeByName = new Map(b.map((c) => [c.name, c]));
    assert.equal(nativeByName.size, b.length);
    const phase = (name) => concurrencyGroup(name) ?? name;
    assert.deepEqual(
      a.map((c) => phase(c.name)),
      b.map((c) => phase(c.name)),
      "Sequential barriers retain response order",
    );
    for (const observed of a) {
      const other = nativeByName.get(observed.name);
      assert.ok(other);
      if (
        JSON.stringify([
          observed.status,
          observed.comparisonBody ?? observed.body,
        ]) !==
        JSON.stringify([other.status, other.comparisonBody ?? other.body])
      )
        p.differences.push({
          name: observed.name,
          node: { status: observed.status, body: observed.body },
          rust: { status: other.status, body: other.body },
        });
    }
  }
  report.compatibilityPassed = report.profiles.every(
    (p) => p.differences.length === 0 && p.auditDifferences.length === 0,
  );
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await h?.close();
  await pg?.close();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      report: reportPath,
      compatibilityPassed: report.compatibilityPassed,
      profiles: report.profiles.map((p) => ({
        profile: p.profile,
        calls: p.peers.map((v) => v.calls.length),
        differences: p.differences.length,
        auditDifferences: p.auditDifferences.length,
      })),
      failure: report.failure,
    }),
  );
}
if (failure) throw failure;
assert.equal(
  report.compatibilityPassed,
  true,
  "All atomic delivery response, decrypted worker result and audit comparisons must match Source",
);
