import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type {
  AgentInteractionRequestCreate,
  EncryptedAgentInteractionRequestCreate,
} from "@cantrip/protocol";
import { AgentInteractionRepository } from "../src/db/repository/agent-interactions.js";
import type { RepositoryDatabase } from "../src/db/repository/database.js";
import * as schema from "../src/db/schema.js";

const migrationsDirectory = fileURLToPath(
  new URL("../drizzle", import.meta.url),
);
const migrationName = "0198_computer_use_interaction_owner.sql";
const chatId = "42fb12b0-046d-4229-a727-fc3f3e98d1a1";

async function applyMigrations(database: PGlite, last: number) {
  for (const name of (await readdir(migrationsDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    if (Number(name.slice(0, 4)) <= last)
      await database.exec(
        await readFile(`${migrationsDirectory}/${name}`, "utf8"),
      );
  }
}
async function seed(database: PGlite) {
  await database.exec(`
    INSERT INTO users (id, kind, role, status, display_name, email, normalized_email, password_hash)
      VALUES ('owner', 'account', 'owner', 'active', 'Fixture', 'fixture@example.com', 'fixture@example.com', 'hash');
    INSERT INTO workers (id, owner_id, name, platform, architecture, started_at, last_seen_at)
      VALUES ('worker', 'owner', 'Fixture', 'darwin', 'arm64', now(), now());
    INSERT INTO projects (id, owner_id, protected_label, github_repository_blind_index)
      VALUES ('project', 'owner', '{}', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    INSERT INTO project_sources (id, project_id, worker_id, absolute_path, display_path)
      VALUES ('source', 'project', 'worker', 'fixture-source-path', 'fixture-source');
    INSERT INTO project_worktrees (id, project_source_id, worker_id, name, absolute_path, display_path, is_primary, is_default, origin, lifecycle_state)
      VALUES ('worktree', 'source', 'worker', 'main', 'fixture-worktree-path', 'fixture-worktree', true, true, 'cantrip', 'ready');
    INSERT INTO chats (id, owner_id, project_id, protected_label, active_worktree_id, status)
      VALUES ('${chatId}', 'owner', 'project', '{}', 'worktree', 'idle');
  `);
}
const protectedPayload = {
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
function nativeRequest(): AgentInteractionRequestCreate {
  return {
    requestKey: randomUUID(),
    projectId: "project",
    provenance: {
      owner: "computer-use",
      chatId,
      threadId: null,
      turnId: null,
      itemId: null,
      executionLaneId: null,
      workerId: "worker",
    },
    payload: {
      kind: "permissions",
      source: "native-computer-use",
      startedAtMs: 0,
      environmentId: null,
      cwd: null,
      reason: "Native computer use",
      requestedPermissions: { computerUse: true },
    },
    expiresAt: null,
  };
}
function encryptedRequest(): EncryptedAgentInteractionRequestCreate {
  const { payload: _payload, ...request } = nativeRequest();
  return {
    ...request,
    classification: { kind: "permissions" },
    protectedPayload,
  };
}
function codexRequest(): AgentInteractionRequestCreate {
  const request = nativeRequest();
  return {
    ...request,
    provenance: {
      chatId,
      threadId: "native-codex-thread",
      turnId: null,
      itemId: null,
      executionLaneId: null,
      workerId: "worker",
    },
    payload: {
      kind: "permissions",
      startedAtMs: 0,
      environmentId: null,
      cwd: "/fixture",
      reason: null,
      requestedPermissions: { fileSystem: { read: ["/fixture"] } },
    },
  };
}

describe("CUA interaction-owner migration", () => {
  it("preserves historical rows, rolls back an interrupted migration, and constrains nullable native identity", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 197);
      await seed(database);
      await database.exec(`INSERT INTO agent_interaction_requests (id, request_key, owner_id, project_id, chat_id, worker_id, thread_id, kind, protected_payload, expires_at)
        VALUES ('historical-request', 'historical-key', 'owner', 'project', '${chatId}', 'worker', 'native-codex-thread', 'permissions', '{"legacy":"unchanged-ciphertext"}', '2030-01-01T00:00:00Z');`);
      const before = (
        await database.query<{ row: object }>(
          "SELECT to_jsonb(r) AS row FROM agent_interaction_requests r",
        )
      ).rows;
      const migration = await readFile(
        `${migrationsDirectory}/${migrationName}`,
        "utf8",
      );
      const statements = migration.split("--> statement-breakpoint");
      for (let completed = 1; completed <= statements.length; completed++) {
        await database.exec("BEGIN");
        await database.exec(statements.slice(0, completed).join("\n"));
        await database.exec("ROLLBACK");
        expect(
          (
            await database.query<{ is_nullable: string }>(
              "SELECT is_nullable FROM information_schema.columns WHERE table_name='agent_interaction_requests' AND column_name='thread_id'",
            )
          ).rows,
        ).toEqual([{ is_nullable: "NO" }]);
        expect(
          (
            await database.query(
              "SELECT 1 FROM information_schema.columns WHERE table_name='agent_interaction_requests' AND column_name='interaction_owner'",
            )
          ).rows,
        ).toEqual([]);
        expect(
          (
            await database.query<{ row: object }>(
              "SELECT to_jsonb(r) AS row FROM agent_interaction_requests r",
            )
          ).rows,
        ).toEqual(before);
      }
      await database.exec(`BEGIN; ${migration} COMMIT;`);
      expect(
        (
          await database.query<{ row: object }>(
            "SELECT to_jsonb(r) - 'interaction_owner' AS row FROM agent_interaction_requests r",
          )
        ).rows,
      ).toEqual(before);
      expect(
        (
          await database.query(
            "SELECT interaction_owner FROM agent_interaction_requests",
          )
        ).rows,
      ).toEqual([{ interaction_owner: "codex" }]);
      const insert = (
        owner: string,
        chat: string,
        thread: string,
        kind = "permissions",
      ) =>
        database.exec(`INSERT INTO agent_interaction_requests (id, request_key, owner_id, project_id, chat_id, worker_id, interaction_owner, thread_id, kind)
        VALUES ('${randomUUID()}', '${randomUUID()}', 'owner', 'project', ${chat}, 'worker', '${owner}', ${thread}, '${kind}');`);
      await insert("computer-use", `'${chatId}'`, "NULL");
      for (const [owner, chat, thread, kind] of [
        ["codex", `'${chatId}'`, "NULL", "permissions"],
        ["computer-use", "NULL", "NULL", "permissions"],
        ["unknown", `'${chatId}'`, "'thread'", "permissions"],
        ["computer-use", `'${chatId}'`, "NULL", "fileChange"],
      ])
        await expect(insert(owner!, chat!, thread!, kind!)).rejects.toThrow(
          /provenance_owner_check/u,
        );
      expect(
        (
          await database.query(
            "SELECT count(*)::int AS count FROM agent_interaction_requests",
          )
        ).rows,
      ).toEqual([{ count: 2 }]);
    } finally {
      await database.close();
    }
  }, 30_000);
});

describe("CUA durable interaction lifecycle without Codex chat-state changes", () => {
  let database: PGlite;
  let repository: AgentInteractionRepository;
  const chatStatus = async () =>
    (
      await database.query<{ status: string }>(
        `SELECT status FROM chats WHERE id='${chatId}'`,
      )
    ).rows[0]!.status;
  beforeAll(async () => {
    database = new PGlite();
    await applyMigrations(database, 198);
    await seed(database);
    repository = new AgentInteractionRepository(
      drizzle(database, { schema }) as unknown as RepositoryDatabase,
      {
        expireAgentInteractionRequests: (now) =>
          repository.expireAgentInteractionRequests(now),
        getAgentInteractionRequest: (owner, id) =>
          repository.getAgentInteractionRequest(owner, id),
      },
    );
  }, 30_000);
  beforeEach(async () => {
    await database.exec("BEGIN");
  });
  afterEach(async () => {
    await database.exec("ROLLBACK");
  });
  afterAll(async () => {
    await database?.close();
  });

  it("stores real UUIDs and null native thread/turn with idempotent encrypted CUA replay", async () => {
    const input = encryptedRequest();
    const request =
      await repository.recordEncryptedAgentInteractionRequest(input);
    expect(request.id).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u,
    );
    expect(request.provenance).toMatchObject({
      owner: "computer-use",
      chatId,
      threadId: null,
      turnId: null,
    });
    expect(
      await repository.recordEncryptedAgentInteractionRequest(input),
    ).toEqual(request);
    expect(await chatStatus()).toBe("idle");
    expect(
      await repository.getAgentInteractionRequest("another-owner", request.id),
    ).toBeNull();
  });

  it("preserves historical absent-owner JSON and accepts explicit Codex replay", async () => {
    const input = codexRequest();
    const first = await repository.recordAgentInteractionRequest(input);
    expect(JSON.stringify(first.provenance)).toBe(
      JSON.stringify(input.provenance),
    );
    expect(first.provenance).not.toHaveProperty("owner");
    expect(await repository.recordAgentInteractionRequest(input)).toEqual(
      first,
    );
    expect(
      await repository.recordAgentInteractionRequest({
        ...input,
        provenance: { ...input.provenance, owner: "codex" },
      }),
    ).toEqual(first);
    expect(await chatStatus()).toBe("waiting-for-approval");
    const native = nativeRequest();
    await expect(
      repository.recordAgentInteractionRequest({
        ...native,
        requestKey: input.requestKey,
      }),
    ).rejects.toThrow(/reused with different/u);
  });

  it("preserves encrypted Codex replay when explicit provenance owner is added", async () => {
    const { payload: _payload, ...codex } = codexRequest();
    const input: EncryptedAgentInteractionRequestCreate = {
      ...codex,
      classification: { kind: "permissions" },
      protectedPayload,
    };
    const first =
      await repository.recordEncryptedAgentInteractionRequest(input);
    expect(first.provenance).not.toHaveProperty("owner");
    expect(
      await repository.recordEncryptedAgentInteractionRequest({
        ...input,
        provenance: {
          ...input.provenance,
          owner: "codex",
          threadId: "native-codex-thread",
        },
      }),
    ).toEqual(first);
    await expect(
      repository.recordEncryptedAgentInteractionRequest({
        ...encryptedRequest(),
        requestKey: input.requestKey,
      }),
    ).rejects.toThrow("reused with different request data");
  });

  it("does not mark idle chat waiting or running for CUA resolution and replay", async () => {
    const request =
      await repository.recordEncryptedAgentInteractionRequest(
        encryptedRequest(),
      );
    const input = {
      idempotencyKey: randomUUID(),
      classification: { kind: "permissions" as const },
      protectedResponse: protectedPayload,
    };
    expect(await chatStatus()).toBe("idle");
    const resolved = await repository.resolveEncryptedAgentInteractionRequest(
      "owner",
      request.id,
      input,
    );
    expect(resolved?.status).toBe("resolved");
    expect(
      await repository.resolveEncryptedAgentInteractionRequest(
        "owner",
        request.id,
        input,
      ),
    ).toEqual(resolved);
    expect(await chatStatus()).toBe("idle");
  });

  it("does not restore chat status when CUA expires, is interrupted, or is terminalized by its worker", async () => {
    const expiring = await repository.recordEncryptedAgentInteractionRequest({
      ...encryptedRequest(),
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    const interrupted =
      await repository.recordEncryptedAgentInteractionRequest(
        encryptedRequest(),
      );
    const terminalized =
      await repository.recordEncryptedAgentInteractionRequest(
        encryptedRequest(),
      );
    await database.exec(
      `UPDATE chats SET status='waiting-for-approval' WHERE id='${chatId}'`,
    );
    const expired = await repository.expireAgentInteractionRequests(
      new Date("2031-01-01T00:00:00Z"),
    );
    expect(expired.map((request) => request.id)).toEqual([expiring.id]);
    expect(await chatStatus()).toBe("waiting-for-approval");
    expect(
      await repository.terminalizeAgentInteractionRequestFromWorker(
        terminalized.requestKey,
        chatId,
        "worker",
        "interrupted",
      ),
    ).toMatchObject({ id: terminalized.id, status: "interrupted" });
    expect(await chatStatus()).toBe("waiting-for-approval");
    expect(
      (await repository.interruptAgentInteractionRequests(chatId)).map(
        (request) => request.id,
      ),
    ).toEqual([interrupted.id]);
    expect(await chatStatus()).toBe("waiting-for-approval");
  });

  it("restores completed Codex approval even while CUA approval remains pending", async () => {
    const codex =
      await repository.recordAgentInteractionRequest(codexRequest());
    const native =
      await repository.recordAgentInteractionRequest(nativeRequest());
    expect(await chatStatus()).toBe("waiting-for-approval");
    await repository.resolveAgentInteractionRequest("owner", codex.id, {
      idempotencyKey: randomUUID(),
      response: {
        kind: "permissions",
        permissions: {},
        scope: "turn",
        strictAutoReview: false,
      },
    });
    expect(await chatStatus()).toBe("running");
    expect(
      (await repository.getAgentInteractionRequest("owner", native.id))?.status,
    ).toBe("pending");
  });

  it("restores expired Codex approval while a CUA approval remains pending", async () => {
    const codex = await repository.recordAgentInteractionRequest({
      ...codexRequest(),
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    const native =
      await repository.recordAgentInteractionRequest(nativeRequest());
    expect(
      await repository.expireAgentInteractionRequests(
        new Date("2031-01-01T00:00:00Z"),
      ),
    ).toMatchObject([{ id: codex.id, status: "expired" }]);
    expect(await chatStatus()).toBe("running");
    expect(
      (await repository.getAgentInteractionRequest("owner", native.id))?.status,
    ).toBe("pending");
  });

  it("never lets a CUA resolution restore another pending Codex approval", async () => {
    await repository.recordAgentInteractionRequest(codexRequest());
    const native =
      await repository.recordAgentInteractionRequest(nativeRequest());
    await repository.resolveAgentInteractionRequest("owner", native.id, {
      idempotencyKey: randomUUID(),
      response: {
        kind: "permissions",
        permissions: {},
        scope: "session",
        strictAutoReview: false,
      },
    });
    expect(await chatStatus()).toBe("waiting-for-approval");
  });
});
