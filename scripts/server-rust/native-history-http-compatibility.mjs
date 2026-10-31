// Real HTTP, unchanged worker protection/recovery and committed publication SQL.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample, buildRustServer } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import {
  settingsHttpFixture,
  settingsChat,
  settingsWorker,
  until,
} from "./native-settings-http-fixture.mjs";
import { literal } from "./project-target-state.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { heartbeat, password } from "./security-fixtures.mjs";
import { NativeHistoryClient } from "../../cantrip_worker/src/native-history-client.ts";
import { prepareNativeHistoryRenderedItem } from "../../cantrip_worker/src/native-history-prepare-item.ts";
import {
  protectNativeHistoryTurnMetadata,
  openNativeHistoryTurn,
} from "../../cantrip_worker/src/native-history-turn-content.ts";
import { openNativeHistoryItemEvidence } from "../../cantrip_worker/src/native-history-item-content.ts";
import { openNativeHistoryBatchArchivePage } from "../../cantrip_worker/src/native-history-batch-archive.ts";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const root = await mkdtemp(path.join(tmpdir(), "cantrip-history-http-"));
const privateMarker = "private-history-evidence-marker",
  privateFailure = "private-history-ack-marker";
const report = {
  suite: "production-native-history-http",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
let pg, active, failure;
async function value(repository, request) {
  const response = await repository.request(request);
  assert.equal(response.rejected, false, response.diagnostic);
  return response.value;
}
function observed(server, action, commit) {
  return server.events.filter(
    (e) =>
      e.event === "fixture.native-history.publication.persisted" &&
      e.action === action &&
      e.identity[2] === commit &&
      e.changed,
  );
}
try {
  const executable = await buildRustServer(),
    repositoryExecutable = await buildRustExample("project-repository-fixture"),
    passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !option("--profile") || option("--profile") === p,
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const result = { kind, proofs: [], errors: [] };
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
        result: { observations: [], snapshotProofs: 0, defaultsProofs: 0 },
        environment: {
          CANTRIP_TEST_HISTORY_OBSERVATIONS: "true",
          CANTRIP_FIXTURE_LOGGING: "true",
          CANTRIP_API_BODY_LIMIT_BYTES: "1048576",
        },
        prepare: async ({ repository }) => {
          await repository.seed("CREATE SEQUENCE history_ack_failure_counter");
          await repository.seed(
            `CREATE FUNCTION history_ack_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('history_ack_failure_counter')=1 THEN RAISE EXCEPTION '${privateFailure}' USING ERRCODE='23514'; END IF; RETURN OLD; END $$`,
          );
          await repository.seed(
            "CREATE TRIGGER history_ack_failure BEFORE DELETE ON native_history_publications FOR EACH ROW EXECUTE FUNCTION history_ack_failure()",
          );
        },
      }));
      const openRepository = () =>
        repositoryFixture({
          kind,
          executable: repositoryExecutable,
          root: path.join(root, profile),
          databaseMode,
          databaseUrl: url,
        });
      const client = new NativeHistoryClient({
        serverUrl: h.fixture.server.origin,
        workerId: settingsWorker,
        token: () => h.credential,
      });
      const post = async (
        name,
        action,
        body,
        { token = h.credential, status, code } = {},
      ) => {
        const response = await fetch(
          new URL(
            "/api/internal/native-history/" + action,
            h.fixture.server.origin,
          ),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(token ? { authorization: "Bearer " + token } : {}),
            },
            body: JSON.stringify(body),
          },
        );
        const payload = await response.json();
        assert.equal(
          response.status,
          status,
          name + ": " + JSON.stringify(payload),
        );
        assert.equal(payload.code, code, name);
        result.errors.push({ name, status, code });
        return payload;
      };
      const checkDiagnostics = (server) => {
        assert.equal(
          server.diagnostics().includes(privateMarker),
          false,
          "private history remains opaque in server diagnostics",
        );
        assert.equal(
          server.diagnostics().includes(privateFailure),
          false,
          "SQL diagnostics are metadata-only",
        );
      };
      try {
        const first = h.fixture.server;
        const openInput = {
          workerId: settingsWorker,
          chatId: settingsChat,
          threadId: "thread",
          provenance: { kind: "current" },
        };
        const invalids = {
          open: "binding",
          resolve: "resolution",
          ingest: "batch",
          archive: "archive",
          "archive-turns": "turn-archive",
          "archive-batches": "batch-archive",
        };
        for (const [action, invalid] of Object.entries(invalids))
          await post(
            "parse before authentication " + action,
            action,
            {},
            {
              token: null,
              status: 400,
              code: "invalid-native-history-" + invalid,
            },
          );
        const oversized = await post(
          "general API body limit remains enforced",
          "resolve",
          { padding: "x".repeat(1048576) },
          { status: 413, code: "FST_ERR_CTP_BODY_TOO_LARGE" },
        );
        assert.deepEqual(oversized, {
          statusCode: 413,
          code: "FST_ERR_CTP_BODY_TOO_LARGE",
          error: "Payload Too Large",
          message: "Request body is too large",
        });
        await post("worker credential required", "open", openInput, {
          token: null,
          status: 401,
          code: "unauthorized",
        });
        await post(
          "credential cannot impersonate another worker",
          "open",
          { ...openInput, workerId: "another-worker" },
          { status: 401, code: "unauthorized" },
        );
        await post(
          "owned chat required",
          "open",
          { ...openInput, chatId: "missing-chat" },
          { status: 404, code: "chat-not-found" },
        );
        const binding = await client.open({
          chatId: settingsChat,
          threadId: "thread",
          provenance: { kind: "current" },
        });
        assert.deepEqual(
          await client.open({
            chatId: settingsChat,
            threadId: "thread",
            provenance: { kind: "binding", bindingId: binding.id },
          }),
          binding,
        );
        assert.equal(binding.workerId, settingsWorker);
        const identity = {
          threadId: "thread",
          turnId: "http-turn",
          itemId: "http-item",
          component: "assistant",
          identityKind: "canonical",
        };
        const [mapping] = await client.resolve({
          chatId: settingsChat,
          bindingId: binding.id,
          items: [{ identity, association: { kind: "native" } }],
        });
        const source = {
          id: identity.itemId,
          identityKind: "canonical",
          revision: 1,
          ordinal: 0,
          body: {
            type: "agentMessage",
            text: privateMarker,
            completeSource: "x".repeat(1100000),
          },
          lifecycle: "completed",
          completeBody: true,
          startedAtMs: null,
          completedAtMs: null,
          origin: { generation: "http-history", sequence: 1, kind: "snapshot" },
          conflicts: [],
        };
        const item = await prepareNativeHistoryRenderedItem({
          service: h.encryption,
          binding,
          mapping,
          revision: 1,
          order: { turn: 0, item: 0, component: 0 },
          attachments: [],
          rendered: {
            identity,
            source,
            message: {
              role: "assistant",
              mode: "default",
              content: [{ type: "text", text: privateMarker }],
            },
            unresolved: [],
          },
        });
        item.expectedRevision = 0;
        const turnSource = {
          version: 1,
          nativeTurn: { id: identity.turnId, privateField: privateMarker },
        };
        const turn = await protectNativeHistoryTurnMetadata({
          service: h.encryption,
          binding,
          header: {
            threadId: "thread",
            turnId: identity.turnId,
            revision: 1,
            ordinal: 0,
            status: "completed",
            startedAtMs: null,
            completedAtMs: null,
          },
          content: turnSource,
        });
        const input = {
          chatId: settingsChat,
          bindingId: binding.id,
          streamId: randomUUID(),
          sequence: 1,
          recordId: randomUUID(),
          digest: createHash("sha256")
            .update("exact-source-record")
            .digest("hex"),
          previousDigest: null,
          batch: { items: [item], turns: [turn] },
        };
        assert.ok(
          Buffer.byteLength(JSON.stringify(input)) > 1048576,
          "valid history exceeds configured general API limit",
        );
        assert.equal(JSON.stringify(input).includes(privateMarker), false);
        const validRequests = {
          open: openInput,
          resolve: {
            workerId: settingsWorker,
            chatId: settingsChat,
            bindingId: binding.id,
            items: [{ identity, association: { kind: "native" } }],
          },
          archive: {
            workerId: settingsWorker,
            chatId: settingsChat,
            bindingId: binding.id,
          },
          "archive-turns": {
            workerId: settingsWorker,
            chatId: settingsChat,
            bindingId: binding.id,
          },
          "archive-batches": {
            workerId: settingsWorker,
            chatId: settingsChat,
            bindingId: binding.id,
          },
          ingest: { ...input, workerId: settingsWorker },
        };
        for (const [action, request] of Object.entries(validRequests))
          await post(
            "all history endpoints require worker credentials: " + action,
            action,
            request,
            { token: null, status: 401, code: "unauthorized" },
          );
        if (profile === "accounts") {
          const code = await h.visit(
            "foreign history enrollment code",
            "POST",
            "/api/workers/enrollment-codes",
            {
              client: "other",
              status: 201,
              json: { label: "Foreign history worker" },
            },
          );
          const foreign = await h.visit(
            "foreign history worker enrollment",
            "POST",
            "/api/internal/workers/enroll",
            {
              client: "foreign-worker",
              status: 201,
              json: {
                code: code.code,
                heartbeat: { ...heartbeat, workerId: "foreign-history-worker" },
              },
            },
          );
          for (const [action, request] of Object.entries(validRequests))
            await post(
              "another account cannot access history: " + action,
              action,
              { ...request, workerId: "foreign-history-worker" },
              {
                token: foreign.credential,
                status: 404,
                code: "chat-not-found",
              },
            );
        }
        const receipt = await client.ingest(input);
        assert.deepEqual(
          await client.ingest(input),
          receipt,
          "uncertain response retries return immutable receipt",
        );
        await until(
          () => observed(first, "ack", receipt.commitId),
          (rows) => rows.length === 1,
        );
        const deferred = observed(first, "defer", receipt.commitId);
        assert.equal(
          deferred.length,
          1,
          "actual SQL acknowledgment failure durably deferred once",
        );
        assert.deepEqual(deferred[0].identity, [
          h.owner,
          binding.id,
          receipt.commitId,
        ]);
        assert.ok(Number.isSafeInteger(deferred[0].dueMs));
        const events = await until(
          () =>
            h.live.history.filter(
              (e) =>
                e.type === "event" &&
                e.resource === "chat-message" &&
                e.entityId === receipt.commitId,
            ),
          (rows) => rows.length >= 2,
        );
        assert.equal(
          events.length,
          2,
          "failed acknowledgment republishes exact commit invalidation",
        );
        for (const event of events)
          assert.deepEqual(
            {
              scope: event.scope,
              action: event.action,
              revision: event.revision,
              payload: event.payload,
            },
            {
              scope: { kind: "chat", chatId: settingsChat },
              action: "invalidated",
              revision: null,
              payload: null,
            },
          );
        result.proofs.push(
          "over-limit encrypted history, unchanged worker client, immutable receipt, real SQL failure/defer/retry/ack and exact App Live invalidation",
        );
        const archiveRequest = { chatId: settingsChat, bindingId: binding.id };
        const archive = await client.archive(archiveRequest);
        assert.equal(archive.items.length, 1);
        assert.equal(archive.items[0].messageId, mapping.messageId);
        assert.deepEqual(
          await openNativeHistoryItemEvidence({
            service: h.encryption,
            binding,
            identity,
            evidence: archive.items[0].evidence,
          }),
          source,
        );
        const turns = await client.archiveTurns({
          ...archiveRequest,
          snapshotId: archive.snapshotId,
        });
        assert.equal(turns.turns.length, 1);
        assert.deepEqual(
          await openNativeHistoryTurn({
            service: h.encryption,
            binding,
            turn: turns.turns[0].turn,
          }),
          turnSource,
        );
        const batches = await client.archiveBatches({
          ...archiveRequest,
          snapshotId: archive.snapshotId,
        });
        const opened = await openNativeHistoryBatchArchivePage({
          service: h.encryption,
          page: batches,
        });
        assert.equal(opened.batches.length, 1);
        assert.deepEqual(opened.batches[0].receipt, receipt);
        assert.deepEqual(opened.batches[0].source.items[0].source, source);
        assert.deepEqual(opened.batches[0].source.turns[0].source, turnSource);
        result.proofs.push(
          "all three pinned archive endpoints pass unchanged worker integrity checks and decrypt complete item/turn evidence",
        );
        // A different payload with the accepted record identity cannot mutate a commit.
        await post(
          "receipt payload mismatch",
          "ingest",
          {
            ...input,
            workerId: settingsWorker,
            batch: { items: [], turns: [] },
          },
          { status: 409, code: "batch-receipt-conflict" },
        );
        const conflict = {
          ...input,
          sequence: 2,
          recordId: randomUUID(),
          previousDigest: input.digest,
          digest: "b".repeat(64),
          batch: {
            items: [
              {
                ...item,
                revision: 2,
                expectedRevision: 0,
                evidence: undefined,
              },
            ],
            turns: [],
          },
        };
        const rejected = await post(
          "canonical revision rejection",
          "ingest",
          { ...conflict, workerId: settingsWorker },
          { status: 409, code: "item-revision-conflict" },
        );
        const repeated = await post(
          "permanent rejection replay",
          "ingest",
          { ...conflict, workerId: settingsWorker },
          { status: 409, code: "item-revision-conflict" },
        );
        assert.deepEqual(repeated, rejected);
        result.proofs.push(
          "exact receipt conflicts and immutable canonical revision rejection survive the HTTP boundary",
        );
        checkDiagnostics(first);
        await h.close();
        let repository = await openRepository();
        let pending;
        try {
          const state = await value(repository, {
            op: "query-json",
            sql: `SELECT jsonb_build_object('publications',(SELECT count(*) FROM native_history_publications),'receipts',(SELECT count(*) FROM native_history_receipts),'messages',(SELECT count(*) FROM chat_messages WHERE chat_id=${literal(settingsChat)}),'rejections',(SELECT count(*) FROM native_history_rejections),'ackAttempts',(SELECT last_value FROM history_ack_failure_counter),'sequence',(SELECT acknowledged_sequence FROM native_history_streams WHERE id=${literal(input.streamId)})) result`,
          });
          assert.deepEqual(state, {
            publications: 0,
            receipts: 1,
            messages: 1,
            rejections: 1,
            ackAttempts: 2,
            sequence: 1,
          });
          pending = await value(repository, {
            op: "native-history-ingest",
            owner: h.owner,
            input: {
              ...input,
              workerId: settingsWorker,
              sequence: 2,
              recordId: randomUUID(),
              previousDigest: input.digest,
              digest: "c".repeat(64),
              batch: { items: [], turns: [] },
            },
          });
        } finally {
          await repository.close();
        }
        const restartedKind =
          databaseMode === "postgres"
            ? kind === "node"
              ? "rust"
              : "node"
            : kind;
        h.fixture.kind = restartedKind;
        await h.fixture.start();
        const second = h.fixture.server;
        await until(
          () => observed(second, "ack", pending.commitId),
          (rows) => rows.length === 1,
        );
        checkDiagnostics(second);
        const bootstrap = await h.visit(
          "identity after history restart",
          "GET",
          "/api/bootstrap",
        );
        assert.equal(bootstrap.server.id, h.serverId);
        const restartClient = new NativeHistoryClient({
          serverUrl: second.origin,
          workerId: settingsWorker,
          token: () => h.credential,
        });
        assert.deepEqual(
          await restartClient.open({
            chatId: settingsChat,
            threadId: "thread",
            provenance: { kind: "binding", bindingId: binding.id },
          }),
          binding,
        );
        const recovered = await restartClient.archiveBatches(archiveRequest);
        assert.equal(recovered.batches.length, 2);
        assert.deepEqual(recovered.batches[0].receipt, receipt);
        assert.deepEqual(recovered.batches[1].receipt, pending);
        await h.fixture.close();
        repository = await openRepository();
        try {
          assert.equal(
            await value(repository, {
              op: "query-json",
              sql: "SELECT to_jsonb(count(*)) result FROM native_history_publications",
            }),
            0,
          );
        } finally {
          await repository.close();
        }
        result.proofs.push(
          "restart publishes preexisting committed outbox without worker input and preserves history, credentials, binding and accepted receipts",
        );
        if (databaseMode === "postgres")
          result.proofs.push(
            "pending publication and all accepted history survive Node/Rust handoff in both directions",
          );
        result.privateErrorsRedacted = true;
      } finally {
        await h.close();
        active = null;
      }
    }
    assert.deepEqual(
      { ...outputs[1], kind: undefined },
      { ...outputs[0], kind: undefined },
      profile + " native history effects",
    );
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  for (const close of [() => active?.close(), () => pg?.close()]) {
    try {
      await close();
    } catch (error) {
      failure ??= error;
      (report.cleanupFailures ??= []).push(error.message);
    }
  }
  if (option("--report")) {
    await mkdir(path.dirname(option("--report")), { recursive: true });
    await writeFile(option("--report"), JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
  else console.error("Retained failed native history HTTP fixture:", root);
  console.log(
    JSON.stringify({
      suite: report.suite,
      databaseMode,
      passed: report.passed ?? false,
      profiles: report.profiles.map((p) => ({
        profile: p.profile,
        runtimes: p.outputs.map((o) => ({
          kind: o.kind,
          proofs: o.proofs.length,
          errors: o.errors.length,
        })),
      })),
    }),
  );
}
if (failure) throw failure;
