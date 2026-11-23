import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import type {
  AgentInteractionRequestKind,
  EncryptedAgentInteractionRequestCreate,
} from "@cantrip/protocol";
import * as schema from "../src/db/schema.js";
import { projectAlertFixture } from "./project-alert-fixture.js";

let f: Awaited<ReturnType<typeof projectAlertFixture>>;
const opaque = {
  formatVersion: 1 as const,
  keyRevision: 1,
  envelope: {
    version: 1 as const,
    algorithm: "AES-256-GCM" as const,
    keyRevision: 1,
    nonce: "A".repeat(16),
    ciphertext: "A".repeat(22),
  },
};
beforeAll(async () => {
  f = await projectAlertFixture();
}, 30_000);
afterAll(async () => {
  await f?.close();
});
function input(
  kind: AgentInteractionRequestKind = "fileChange",
  changes: Partial<EncryptedAgentInteractionRequestCreate> = {},
): EncryptedAgentInteractionRequestCreate {
  return {
    requestKey: randomUUID(),
    projectId: f.project,
    provenance: {
      chatId: f.chat,
      threadId: "thread",
      turnId: null,
      itemId: null,
      executionLaneId: null,
      workerId: "alert-worker",
    },
    classification: { kind },
    protectedPayload: opaque,
    expiresAt: null,
    ...changes,
  };
}
const record = (request = input()) =>
  f.db.repository.recordEncryptedAgentInteractionRequest(request);
const page = () => f.db.repository.alerts.list(f.owner, f.project);
const count = async () => (await page())!.items.length;
const clear = () => f.db.repository.interruptAgentInteractionRequests(f.chat);

it("backfills existing pending source requests on upgrade", async () => {
  for (const name of [
    "project_alert_project_interaction(agent_interaction_requests)",
    "project_alert_interaction_changed()",
    "project_alert_chat_retired()",
    "project_alert_turn_retired()",
    "project_alert_lane_retired()",
  ]) {
    await f.db.database.execute(sql.raw(`DROP FUNCTION ${name} CASCADE`));
  }
  let request;
  try {
    request = await record();
    expect(await count()).toBe(0);
  } finally {
    const migration = await readFile(
      new URL(
        "../../../cantrip_server/drizzle/0239_project_alert_interactions.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint"))
      await f.db.database.execute(sql.raw(statement));
  }
  expect((await page())!.items.map((a) => a.sourceId)).toEqual([request!.id]);
  await clear();
  expect(await count()).toBe(0);
});

it("projects every protected approval/input kind, preserves independent requests and follows accepted resolutions", async () => {
  const requests = [];
  for (const kind of [
    "commandExecution",
    "fileChange",
    "permissions",
    "userInput",
    "mcpElicitation",
  ] as const)
    requests.push(await record(input(kind)));
  requests.push(
    await record(
      input("permissions", {
        provenance: {
          chatId: f.chat,
          threadId: null,
          turnId: null,
          itemId: null,
          executionLaneId: null,
          workerId: "alert-worker",
          owner: "computer-use",
        },
      }),
    ),
  );
  expect(await count()).toBe(6);
  const alerts = (await page())!.items;
  for (const request of requests) {
    const alert = alerts.find((a) => a.sourceId === request.id)!;
    expect(alert.target).toEqual({
      kind: "interaction",
      chatId: f.chat,
      requestId: request.id,
    });
    expect(alert.kind).toBe(
      ["userInput", "mcpElicitation"].includes(request.classification.kind)
        ? "user-input"
        : "permission",
    );
    expect(alert.protectedDetail).toBeNull();
    expect(JSON.stringify(alert)).not.toContain("ciphertext");
  }
  const first = requests[0];
  const response = {
    idempotencyKey: "accepted-once",
    classification: first.classification,
    protectedResponse: opaque,
  };
  await f.db.repository.resolveEncryptedAgentInteractionRequest(
    f.owner,
    first.id,
    response,
  );
  await f.db.repository.resolveEncryptedAgentInteractionRequest(
    f.owner,
    first.id,
    response,
  );
  expect(await count()).toBe(5);
  await expect(
    f.db.repository.resolveEncryptedAgentInteractionRequest(f.owner, first.id, {
      ...response,
      idempotencyKey: "different",
    }),
  ).rejects.toThrow();
  expect(await count()).toBe(5);
  await clear();
  expect(await count()).toBe(0);
});

it("deduplicates request replays, expires without a Chat read, and retires deleted requests", async () => {
  const request = input();
  const a = await record(request);
  expect((await record(request)).id).toBe(a.id);
  expect(await count()).toBe(1);
  await f.db.database
    .update(schema.agentInteractionRequests)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(schema.agentInteractionRequests.id, a.id));
  expect(await count()).toBe(0);
  expect(
    (await f.db.repository.getAgentInteractionRequest(f.owner, a.id))?.status,
  ).toBe("expired");
  const b = await record();
  await f.db.database
    .delete(schema.agentInteractionRequests)
    .where(eq(schema.agentInteractionRequests.id, b.id));
  expect(await count()).toBe(0);
});

it("also follows legacy visible requests and settles a concurrent source response once", async () => {
  const {
    classification: _classification,
    protectedPayload: _protectedPayload,
    ...base
  } = input();
  const request = await f.db.repository.recordAgentInteractionRequest({
    ...base,
    payload: {
      kind: "fileChange",
      startedAtMs: 1,
      reason: "Review the change",
      grantRoot: null,
    },
  });
  expect(await count()).toBe(1);
  const results = await Promise.allSettled(
    ["one", "two"].map((idempotencyKey) =>
      f.db.repository.resolveAgentInteractionRequest(f.owner, request.id, {
        idempotencyKey,
        response: { kind: "fileChange", decision: "decline" },
      }),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(await count()).toBe(0);
});

it("retires on archive and Stop, rejects stale resurrection, and permits a genuinely new request", async () => {
  const old = input();
  await record(old);
  await f.db.database
    .update(schema.chats)
    .set({ automationPaused: true })
    .where(eq(schema.chats.id, f.chat));
  expect(await count()).toBe(1); // An intentional pause is not retirement.
  await f.db.database
    .update(schema.chats)
    .set({ archivedAt: new Date() })
    .where(eq(schema.chats.id, f.chat));
  expect(await count()).toBe(0);
  const delayed = input();
  await record(delayed);
  await f.db.database
    .update(schema.chats)
    .set({ archivedAt: null, automationPaused: false })
    .where(eq(schema.chats.id, f.chat));
  await record(old);
  await record(delayed);
  expect(await count()).toBe(0);
  await record();
  expect(await count()).toBe(1);
  await f.db.database
    .update(schema.chats)
    .set({ managedAutonomyStopped: true })
    .where(eq(schema.chats.id, f.chat));
  expect(await count()).toBe(0);
  const stopped = input();
  await record(stopped);
  await f.db.database
    .update(schema.chats)
    .set({ managedAutonomyStopped: false })
    .where(eq(schema.chats.id, f.chat));
  await record(stopped);
  expect(await count()).toBe(0);
  await record();
  expect(await count()).toBe(1);
  await clear();
});

it("retires only the exact completed native turn, including a delayed request first delivered after completion", async () => {
  const binding = randomUUID();
  const chat = (
    await f.db.database
      .select()
      .from(schema.chats)
      .where(eq(schema.chats.id, f.chat))
  )[0];
  await f.db.database.execute(
    sql`INSERT INTO native_history_bindings(id,owner_id,worker_id,chat_id,thread_id,project_id,worktree_id) VALUES (${binding},${f.owner},'alert-worker',${f.chat},'thread',${f.project},${chat.activeWorktreeId})`,
  );
  await f.db.database.execute(
    sql`INSERT INTO native_history_turns(binding_id,turn_id,revision,ordinal,status,metadata,payload_digest) VALUES (${binding},'turn-a',1,0,'inProgress','{}',${"a".repeat(64)})`,
  );
  const a = input();
  a.provenance.turnId = "turn-a";
  await record(a);
  const b = input();
  b.provenance.turnId = "turn-b";
  const next = await record(b);
  expect(await count()).toBe(2);
  await f.db.database.execute(
    sql`UPDATE native_history_turns SET status='completed',revision=2 WHERE binding_id=${binding} AND turn_id='turn-a'`,
  );
  expect((await page())!.items.map((a) => a.sourceId)).toEqual([next.id]);
  const late = input();
  late.provenance.turnId = "turn-a";
  await record(late);
  expect((await page())!.items.map((a) => a.sourceId)).toEqual([next.id]);
  await clear();
});

it("keeps owner isolation and removes alerts on Chat deletion", async () => {
  await record();
  expect(await f.db.repository.alerts.list("unrelated", f.project)).toBeNull();
  expect(await f.db.repository.alerts.counts("unrelated")).toEqual([]);
  await f.db.database.delete(schema.chats).where(eq(schema.chats.id, f.chat));
  expect(await count()).toBe(0);
});
