// Real HTTP, durable admission/dispatch, Live and production endpoint crypto.
// Native runtime command execution remains controlled and is not claimed here.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { nativeEventHttpSpecialCases } from "./native-event-http-special-cases.mjs";
import { password } from "./security-fixtures.mjs";
import {
  settingsHttpFixture,
  settingsChat as chat,
  settingsProject as project,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import {
  seedEventChats,
  prepareEventCommands,
  task,
  taskProject,
  standalone,
  rejectedEventCredentials,
} from "./native-event-http-setup.mjs";
import {
  eventContents,
  eventPrivateMarker,
  computerKey,
  proveEventMessage,
  proveEventStorage,
  scrubEventContent,
} from "./native-event-http-content.mjs";
const option = (k) => {
  const i = process.argv.indexOf(k);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  root = await mkdtemp(path.join(tmpdir(), "cantrip-native-event-http-"));
const report = {
  suite: "actual-native-event-http-live-crypto",
  databaseMode,
  completeReplacement: false,
  lifecycleComplete: false,
  profiles: [],
};
let pg, failure, active;
try {
  const executable = await buildRustServer(),
    repositoryExecutable = await buildRustExample("project-repository-fixture"),
    passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) =>
      !process.argv.includes("--special-only") &&
      (!option("--profile") || p === option("--profile")),
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const result = {
        kind,
        observations: [],
        snapshotProofs: 0,
        cryptoProofs: 0,
        events: [],
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
      }));
      h.prepared = await prepareEventCommands(h);
      const { fixture, visit, live } = h;
      const serverProcess = fixture.server;
      const endpoint = "/api/internal/native-commands/events";
      const auth = {
        client: "worker",
        headers: { authorization: "Bearer " + h.credential },
      };
      const envelope = (chat, event) => ({
        workerId: worker,
        operationId: h.prepared[chat].operationId,
        operationGeneration: h.prepared[chat].operationGeneration,
        event,
      });
      const send = async (name, chat, event, extra = {}) => {
        const before = live.history.filter((e) => e.type === "event").length;
        const body = await visit(name, "POST", endpoint, {
          ...auth,
          json: envelope(chat, event),
          ...extra,
        });
        await live.ping(name);
        const events = live.history
          .filter((e) => e.type === "event")
          .slice(before);
        if (extra.status && extra.status !== 200)
          assert.equal(
            events.length,
            0,
            name + " rejected writes never publish",
          );
        else assert.deepEqual(body, { applied: true });
        result.events.push({
          name,
          events: events.map((e) => ({
            scope: e.scope,
            resource: e.resource,
            action: e.action,
            entityId: e.entityId,
            revision: e.revision,
            payload: scrubEventContent(e.payload),
          })),
        });
        return events;
      };
      try {
        await live.subscribed("all-event-scopes", [
          { kind: "chat", chatId: chat },
          { kind: "chat", chatId: task },
          { kind: "chat", chatId: standalone },
          { kind: "project", projectId: project },
          { kind: "project", projectId: taskProject },
          { kind: "current-user" },
        ]);
        const content = await eventContents(h),
          telemetry = { kind: "checkpoint", turnId: "turn" };
        await visit("event validates before authentication", "POST", endpoint, {
          client: "worker",
          json: {},
          status: 400,
        });
        const event = {
          type: "agent.protected-message",
          message: content.agentMessage,
          telemetry,
        };
        await visit("event requires worker credential", "POST", endpoint, {
          client: "worker",
          json: envelope(chat, event),
          status: 401,
        });
        await send("event credential worker mismatch", chat, event, {
          json: { ...envelope(chat, event), workerId: "unrelated" },
          status: 401,
        });
        for (const credential of rejectedEventCredentials)
          await send("event credential " + credential.reason, chat, event, {
            headers: { authorization: "Bearer " + credential.credential },
            status: 401,
          });
        await send("event stale generation", chat, event, {
          json: { ...envelope(chat, event), operationGeneration: "stale" },
          status: 404,
        });
        await send("event missing operation", chat, event, {
          json: { ...envelope(chat, event), operationId: "missing" },
          status: 404,
        });
        await send(
          "visible events are rejected",
          chat,
          { type: "agent.message", message: {} },
          { status: 400 },
        );
        await send(
          "task event cannot target Agent chat",
          chat,
          {
            type: "agent.protected-task-message",
            message: content.taskMessage,
            telemetry,
          },
          { status: 409 },
        );
        const first = await send("persist encrypted Agent event", chat, event);
        assert.equal(first.length, 1);
        assert.equal(first[0].payload.id, content.agentMessage.id);
        await send("replay encrypted Agent event", chat, event);
        await send("encrypted upsert retains row and updates role", chat, {
          ...event,
          message: {
            ...content.agentMessage,
            classification: {
              ...content.agentMessage.classification,
              role: "user",
            },
          },
        });
        // Changing public classification without re-encryption violates AAD at
        // the endpoint. Restore the original before the cryptographic proof.
        await send("restore protected classification", chat, event);
        await send(
          "Task managed operation remains rejected",
          task,
          {
            type: "agent.protected-task-message",
            message: content.taskMessage,
            telemetry,
          },
          { status: 409 },
        );
        await send(
          "standalone managed command remains rejected",
          standalone,
          {
            type: "agent.protected-message",
            message: content.standaloneMessage,
            telemetry,
          },
          { status: 409 },
        );
        await send("plan event", chat, {
          type: "agent.plan.protected",
          turnId: null,
          state: content.plan,
        });
        await send("encrypted interaction request", chat, {
          type: "agent.interaction.requested.protected",
          request: content.request,
        });
        await send("interaction duplicate request", chat, {
          type: "agent.interaction.requested.protected",
          request: content.request,
        });
        await send(
          "interaction changed ciphertext conflicts atomically",
          chat,
          {
            type: "agent.interaction.requested.protected",
            request: {
              ...content.request,
              protectedPayload: {
                ...content.request.protectedPayload,
                envelope: {
                  ...content.request.protectedPayload.envelope,
                  ciphertext: "A".repeat(32),
                },
              },
            },
          },
          { status: 500 },
        );
        await send(
          "interaction visible answer cannot resolve encrypted request",
          chat,
          {
            type: "agent.interaction.cleared",
            requestKey: content.request.requestKey,
            resolution: {
              idempotencyKey: "wrong",
              response: { kind: "fileChange", decision: "accept" },
            },
          },
          { status: 500 },
        );
        await send("clear retains accepted encrypted response", chat, {
          type: "agent.interaction.cleared",
          requestKey: content.request.requestKey,
          resolution: content.response,
        });
        await send("duplicate accepted worker reply", chat, {
          type: "agent.interaction.cleared",
          requestKey: content.request.requestKey,
          resolution: {
            ...content.response,
            idempotencyKey: "accepted-native-repeat",
          },
        });
        await send("expired event keeps already resolved answer", chat, {
          type: "agent.interaction.expired",
          requestKey: content.request.requestKey,
        });
        const cua = {
          type: "computer-use.approval.request",
          operationId: computerKey,
          request: content.computer,
        };
        await send(
          "computer-use placement guard",
          chat,
          {
            ...cua,
            request: {
              ...content.computer,
              provenance: {
                ...content.computer.provenance,
                executionLaneId: "stale",
              },
            },
          },
          { status: 500 },
        );
        await send("computer-use encrypted approval", chat, cua);
        await send(
          "computer-use terminal provenance guard",
          chat,
          {
            type: "computer-use.approval.terminal",
            chatId: task,
            requestKey: computerKey,
            status: "interrupted",
          },
          { status: 500 },
        );
        await send("computer-use terminal approval", chat, {
          type: "computer-use.approval.terminal",
          chatId: chat,
          requestKey: computerKey,
          status: "interrupted",
        });
        await send("computer-use terminal replay", chat, {
          type: "computer-use.approval.terminal",
          chatId: chat,
          requestKey: computerKey,
          status: "interrupted",
        });
        for (const [id, taskMessage] of [
          [chat, false],
          [task, true],
          [standalone, false],
        ]) {
          const list = await visit(
            "read event history " + id,
            "GET",
            "/api/chats/" + id + "/messages",
          );
          assert.equal(list.messages.length, id === chat ? 1 : 0);
          if (id === chat)
            await proveEventMessage(h, list.messages[0], taskMessage, result);
        }
        assert.equal(
          JSON.stringify([...fixture.records.values(), live.history]).includes(
            eventPrivateMarker,
          ),
          false,
        );
        assert.equal(h.updates.length, 0);
        assert.equal(h.defaultsCalls.length, 0);
      } finally {
        await h.close();
        active = null;
      }
      const repo = await repositoryFixture({
        kind,
        executable: repositoryExecutable,
        root: path.join(root, profile),
        databaseMode,
        databaseUrl: url,
      });
      try {
        const state = await repo.request({
          op: "query-json",
          sql: "SELECT jsonb_build_object('messages',(SELECT jsonb_agg(to_jsonb(m)) FROM chat_messages m),'interactions',(SELECT jsonb_agg(to_jsonb(i)) FROM agent_interaction_requests i),'plans',(SELECT jsonb_agg(jsonb_build_object('id',c.id,'protected_plan',c.protected_plan)) FROM chats c)) result",
        });
        assert.equal(state.rejected, false, state.diagnostic);
        await proveEventStorage(h, state.value, result);
      } finally {
        await repo.close();
      }
      result.observations = scrubEventContent(result.observations);
      result.diagnostics = serverProcess.diagnostics();
      assert.equal(result.diagnostics.includes(eventPrivateMarker), false);
    }
    for (const key of ["observations", "cryptoProofs", "events"])
      assert.deepEqual(outputs[1][key], outputs[0][key], profile + " " + key);
  }
  if (databaseMode === "postgres")
    await nativeEventHttpSpecialCases({
      pg,
      root,
      executable,
      repositoryExecutable,
      passwordHash,
      report,
    });
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
