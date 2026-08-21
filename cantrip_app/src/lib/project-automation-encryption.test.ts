import { generateAccountMasterKey } from "@cantrip/crypto";
import { describe, expect, it } from "vitest";

import type { ClientSessionContext } from "./client-session";
import { ClientEncryptionService } from "./client-encryption";
import {
  openProjectAutomationWire,
  protectProjectAutomationCreate,
  protectProjectAutomationUpdate,
} from "./project-automation-encryption";

const ownerId = "automation-owner";
const serverId = "automation-server";
const timestamp = "2026-08-20T00:00:00.000Z";

function session(): ClientSessionContext {
  return { serverId, user: { id: ownerId } } as ClientSessionContext;
}

function service() {
  const service = new ClientEncryptionService();
  service.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity: { ownerId, serverId },
    masterKeyRevision: 1,
  });
  return service;
}

describe("project automation encryption", () => {
  it("protects create and partial update content before server persistence", async () => {
    const options = { service: service(), session };
    const created = await protectProjectAutomationCreate(
      {
        name: "SENTINEL nightly review",
        chatId: "chat-one",
        prompt: "SENTINEL inspect the private roadmap",
        schedule: {
          kind: "interval",
          every: 1,
          unit: "day",
          startsAt: timestamp,
        },
        condition: { type: "script", script: "test -f private/roadmap.md" },
        enabled: true,
      },
      options,
    );
    expect(JSON.stringify(created)).not.toContain("SENTINEL");
    expect(JSON.stringify(created)).not.toContain("private/roadmap.md");
    const wire = {
      id: created.id,
      projectId: "project-one",
      chatId: created.chatId,
      workerId: "worker-one",
      content: created.content,
      schedule: created.schedule,
      enabled: created.enabled,
      revision: 1,
      nextRunAt: timestamp,
      lastRunAt: null,
      lastStatus: "idle" as const,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await expect(
      openProjectAutomationWire(wire, options),
    ).resolves.toMatchObject({
      name: "SENTINEL nightly review",
      prompt: "SENTINEL inspect the private roadmap",
      condition: { type: "script", script: "test -f private/roadmap.md" },
    });

    const update = await protectProjectAutomationUpdate(
      created.id,
      { prompt: "SENTINEL updated prompt" },
      options,
    );
    expect(JSON.stringify(update)).not.toContain("SENTINEL");
    await expect(
      openProjectAutomationWire(
        {
          ...wire,
          content: { ...wire.content, ...update.content },
          revision: 2,
        },
        options,
      ),
    ).resolves.toMatchObject({ prompt: "SENTINEL updated prompt" });
  });
});
