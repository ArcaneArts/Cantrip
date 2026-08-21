import { generateAccountMasterKey } from "@cantrip/crypto";
import type { ClientSessionContext } from "./client-session";
import { describe, expect, it } from "vitest";

import { ClientEncryptionService } from "./client-encryption";
import {
  openModelProviderAccountWireSummary,
  protectMcpServerCreate,
  protectModelProviderAccountCreate,
} from "./protected-secrets";

const ownerId = "provider-label-owner";
const serverId = "provider-label-server";
const timestamp = "2026-08-21T12:00:00.000Z";

function unlockedOptions() {
  const service = new ClientEncryptionService();
  service.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity: { ownerId, serverId },
    masterKeyRevision: 1,
  });
  return {
    service,
    session: () =>
      ({ serverId, user: { id: ownerId } }) as ClientSessionContext,
  };
}

describe("protected MCP adapter", () => {
  it("rejects the managed CodeGraph name before encryption", async () => {
    await expect(
      protectMcpServerCreate({
        name: "CodeGraph",
        enabled: true,
        transport: "stdio",
        command: "codegraph",
        args: [],
        environment: {},
      }),
    ).rejects.toThrow("reserved");
  });
});

describe("protected provider-account labels", () => {
  it("round-trips without putting the label on the server wire", async () => {
    const options = unlockedOptions();
    const encrypted = await protectModelProviderAccountCreate(
      { label: "Private provider account" },
      options,
    );
    expect(JSON.stringify(encrypted)).not.toContain("Private provider account");

    await expect(
      openModelProviderAccountWireSummary(
        {
          ...encrypted,
          providerId: "provider-1",
          planType: null,
          position: 0,
          enabled: true,
          credentialState: "signed-out",
          weeklyUsageUsedPercent: null,
          weeklyUsageResetsAt: null,
          authLastSyncedAt: null,
          workerBindings: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        options,
      ),
    ).resolves.toMatchObject({ label: "Private provider account" });
  });

  it("rejects ciphertext tampering and row substitution", async () => {
    const options = unlockedOptions();
    const encrypted = await protectModelProviderAccountCreate(
      { label: "Bound account label" },
      options,
    );
    const wire = {
      ...encrypted,
      providerId: "provider-1",
      planType: null,
      position: 0,
      enabled: true,
      credentialState: "signed-out" as const,
      weeklyUsageUsedPercent: null,
      weeklyUsageResetsAt: null,
      authLastSyncedAt: null,
      workerBindings: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const ciphertext = encrypted.protectedLabel.envelope.ciphertext;
    await expect(
      openModelProviderAccountWireSummary(
        {
          ...wire,
          protectedLabel: {
            ...encrypted.protectedLabel,
            envelope: {
              ...encrypted.protectedLabel.envelope,
              ciphertext: `${ciphertext.startsWith("A") ? "B" : "A"}${ciphertext.slice(1)}`,
            },
          },
        },
        options,
      ),
    ).rejects.toMatchObject({ code: "decryption-failed" });
    await expect(
      openModelProviderAccountWireSummary(
        { ...wire, id: crypto.randomUUID() },
        options,
      ),
    ).rejects.toMatchObject({ code: "decryption-failed" });
  });
});
