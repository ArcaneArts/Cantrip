import { generateAccountMasterKey } from "@cantrip/crypto";
import type { TaskDetail } from "@cantrip/protocol/tasks";
import { describe, expect, it } from "vitest";

import type { ClientSessionContext } from "./client-session";
import { ClientEncryptionService } from "./client-encryption";
import {
  createInitialTaskOpaqueContent,
  openTaskOpaqueSummary,
  prepareTaskDraftPersistence,
  prepareTaskEncryptedOperation,
  taskOpaqueSummaryFromCreate,
} from "./task-persistence-encryption";

const ownerId = "owner-task-persistence";
const serverId = "server-task-persistence";
const chatId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";

function session(): ClientSessionContext {
  return { serverId, user: { id: ownerId } } as ClientSessionContext;
}

function readyService() {
  const service = new ClientEncryptionService();
  service.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity: { ownerId, serverId },
    masterKeyRevision: 1,
  });
  return service;
}

describe("trusted Task persistence adapter", () => {
  it("round-trips an empty Task and encrypts a sentinel draft mutation", async () => {
    const service = readyService();
    const options = { service, session };
    const initial = await createInitialTaskOpaqueContent(chatId, options);
    const created = taskOpaqueSummaryFromCreate({
      chatId,
      task: initial,
      createdAt: "2026-08-19T12:00:00.000Z",
    });
    const task = await openTaskOpaqueSummary(created, options);
    const mutation = await prepareTaskDraftPersistence(
      task,
      {
        rowVersion: 1,
        briefMarkdown: "SENTINEL encrypted Task brief",
        draftAttachmentIds: ["attachment-1"],
      },
      options,
    );
    expect(JSON.stringify(mutation)).not.toContain("SENTINEL");
    const opened = await openTaskOpaqueSummary(
      {
        ...created,
        ...mutation.task.classification,
        draftAttachmentIds: mutation.draftAttachmentIds,
        protectedContent: mutation.task.protectedContent,
        rowVersion: 2,
      },
      options,
    );
    expect(opened.briefMarkdown).toBe("SENTINEL encrypted Task brief");
    expect(opened.draftAttachmentIds).toEqual(["attachment-1"]);
  });

  it("prepares opaque running and failure bundles for restart-safe execution", async () => {
    const service = readyService();
    const options = { service, session };
    const initial = await createInitialTaskOpaqueContent(chatId, options);
    const task = await openTaskOpaqueSummary(
      taskOpaqueSummaryFromCreate({
        chatId,
        task: initial,
        createdAt: "2026-08-19T12:00:00.000Z",
      }),
      options,
    );
    const draftMutation = await prepareTaskDraftPersistence(
      task,
      { rowVersion: 1, briefMarkdown: "SENTINEL operation brief" },
      options,
    );
    const saved = (await openTaskOpaqueSummary(
      {
        ...taskOpaqueSummaryFromCreate({
          chatId,
          task: draftMutation.task,
          createdAt: task.createdAt,
        }),
        rowVersion: 2,
      },
      options,
    )) as TaskDetail;
    const operation = await prepareTaskEncryptedOperation(
      saved,
      {
        kind: "initial-plan",
        operationId,
        rowVersion: 2,
      },
      options,
    );
    expect(operation.operation.task.classification).toMatchObject({
      state: "planning",
      activeOperationKind: "initial-plan",
      planningRound: 1,
    });
    expect(operation.failure.task.classification).toMatchObject({
      state: "failed",
      activeOperationKind: null,
    });
    expect(operation.failure.round.classification.status).toBe("failed");
    expect(JSON.stringify(operation)).not.toContain("SENTINEL");
  });

  it("fails closed while the client is locked", async () => {
    await expect(
      createInitialTaskOpaqueContent(chatId, {
        service: new ClientEncryptionService(),
        session,
      }),
    ).rejects.toMatchObject({ code: "locked" });
  });
});
