/** Disposable Alerts QA server. Never imported by a production entrypoint. */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
);
const { PGlite } = require("@electric-sql/pglite");
const { drizzle } = require("drizzle-orm/pglite");
const { migrate } = require("drizzle-orm/pglite/migrator");
const { eq, sql } = require("drizzle-orm");
import type { WorkerCommand } from "@cantrip/protocol";
import { buildApp } from "../../tests/reference-node-server/src/app.js";
import { readServerConfig } from "../../tests/reference-node-server/src/config.js";
import {
  LOCAL_USER_ID,
  ServerRepository,
} from "../../tests/reference-node-server/src/db/repository.js";
import * as schema from "../../tests/reference-node-server/src/db/schema.js";
import { resolveSecretVault } from "../../tests/reference-node-server/src/security/secret-vault.js";
import {
  WorkerBridge,
  type WorkerRequestOptions,
} from "../../tests/reference-node-server/src/workers/bridge.js";
import { installServerShutdownHandlers } from "../../tests/reference-node-server/src/server-shutdown.js";

const token = process.env.CANTRIP_QA_ALERTS_TOKEN;
if (!token)
  throw new Error("Start this fixture through project-alerts-browser.mjs.");
const config = readServerConfig();
config.serverInstanceId ??= randomUUID();
await mkdir(config.dataDirectory, { recursive: true });
const client = new PGlite(path.join(config.dataDirectory, "server-db"));
const db = drizzle(client, { schema });
await migrate(db, {
  migrationsFolder: fileURLToPath(
    new URL("../../cantrip_server/drizzle", import.meta.url),
  ),
});
const repository = new ServerRepository(db, await resolveSecretVault(config));
await repository.ensureLocalIdentity();
await repository.policies.ensureOwnerState(LOCAL_USER_ID);
// Unreachable local model: this fixture never has paid credentials or makes an LLM call.
await repository.ensureDefaultModelConfiguration(
  LOCAL_USER_ID,
  "qa-model",
  "http://127.0.0.1:1",
);
const unlisten = await client.listen("cantrip_project_alerts", (payload) =>
  repository.alerts.receive(payload),
);
const executions = new Set<string>();
let failReplies = false;
class AlertFixtureBridge extends WorkerBridge {
  override async request(
    workerId: string,
    command: WorkerCommand,
    options?: WorkerRequestOptions,
  ) {
    if (
      command.type === "agent.interaction.respond" ||
      command.type === "agent.interaction.respond.protected"
    ) {
      if (failReplies) throw new Error("Injected QA reply rejection");
      // Native RPC's per-request acceptance is isolated; the HTTP validation,
      // encrypted response, projection and commit notifications remain real.
      executions.add(command.requestKey);
      return { accepted: true };
    }
    return super.request(workerId, command, options);
  }
}
const bridge = new AlertFixtureBridge();
const app = await buildApp({
  config,
  workerBridge: bridge,
  database: {
    engine: "pglite",
    repository,
    ping: async () => {
      await client.query("select 1");
    },
    close: async () => {
      await unlisten();
      await client.close();
    },
  },
  workerLinkTiming: { sessionLeaseMs: 45_000, sweepIntervalMs: 250 },
});
// Private fixture-only route. The app still applies normal session/CSRF rules.
app.post<{ Body: Record<string, any> }>(
  "/api/__qa/alerts",
  async (request, reply) => {
    if (request.headers["x-cantrip-qa"] !== token)
      return reply.code(403).send();
    const input = request.body;
    if (input.op === "stats") return { executions: [...executions] };
    if (input.op === "fail-replies") {
      failReplies = input.enabled;
      return { ok: true };
    }
    const [chat] = await db
      .select()
      .from(schema.chats)
      .where(eq(schema.chats.id, input.chatId));
    if (!chat || chat.ownerId !== LOCAL_USER_ID)
      return reply.code(404).send({ error: "Fixture Chat not found" });
    if (input.op === "prepare") {
      const current = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        chat.id,
      );
      const acquired =
        current?.executionLaneId || input.execute === false
          ? current
          : await repository.startChatExecutionLane(
              LOCAL_USER_ID,
              chat.id,
              "agent",
              "Alerts QA",
            );
      if (!acquired) throw new Error("Cannot acquire fixture execution lane");
      await db
        .insert(schema.chatRuntimeSessions)
        .values({
          id: randomUUID(),
          chatId: chat.id,
          workerId: acquired.workerId,
          worktreeId: chat.activeWorktreeId,
          codexThreadId: `qa-${chat.id}`,
        })
        .onConflictDoNothing();
      await db
        .update(schema.chatRuntimeSessions)
        .set({ codexThreadId: `qa-${chat.id}` })
        .where(eq(schema.chatRuntimeSessions.chatId, chat.id));
      return repository.getChatExecutionContext(LOCAL_USER_ID, chat.id);
    }
    const context = await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chat.id,
    );
    if (!context) throw new Error("Fixture Chat context not found");
    if (input.op === "interaction")
      return repository.recordEncryptedAgentInteractionRequest({
        requestKey: input.requestKey,
        projectId: chat.projectId!,
        classification: input.classification,
        protectedPayload: input.protectedPayload,
        expiresAt: null,
        provenance: {
          chatId: chat.id,
          threadId: context.threadId!,
          turnId: `qa-turn-${chat.id}`,
          itemId: null,
          executionLaneId: context.executionLaneId,
          workerId: context.workerId,
        },
      });
    if (input.op === "retire") {
      if (input.reason === "delete")
        await db.delete(schema.chats).where(eq(schema.chats.id, chat.id));
      else
        await db
          .update(schema.chats)
          .set(
            input.reason === "archive"
              ? { archivedAt: new Date() }
              : { managedAutonomyStopped: true },
          )
          .where(eq(schema.chats.id, chat.id));
      return { ok: true };
    }
    if (input.op === "agent")
      return repository.alerts.applyAgent(
        LOCAL_USER_ID,
        context,
        input.mutation,
      );
    if (input.op === "goal") {
      const generation = bridge.connectionIdentity(
        context.workerId,
      )?.workerProcessGeneration;
      if (!generation) throw new Error("Fixture Worker is not attached");
      await repository.alerts.registerGoalWorker(
        LOCAL_USER_ID,
        context.workerId,
        generation,
      );
      return repository.alerts.observeGoal(LOCAL_USER_ID, {
        chatId: chat.id,
        workerId: context.workerId,
        threadId: context.threadId!,
        generation,
        revision: input.revision,
        snapshot: input.snapshot,
      });
    }
    if (input.op === "task") {
      const c = input.content.classification;
      await db
        .update(schema.chats)
        .set({ experience: "task" })
        .where(eq(schema.chats.id, chat.id));
      const values = {
        ...c,
        protectedContent: input.content.protectedContent,
        updatedAt: new Date(),
      };
      await db
        .insert(schema.tasks)
        .values({ chatId: chat.id, ...values })
        .onConflictDoUpdate({
          target: schema.tasks.chatId,
          set: { ...values, rowVersion: sql`${schema.tasks.rowVersion}+1` },
        });
      return { ok: true };
    }
    return reply.code(400).send({ error: "Unknown fixture operation" });
  },
);
installServerShutdownHandlers(app);
await app.listen({ host: config.host, port: config.port });
