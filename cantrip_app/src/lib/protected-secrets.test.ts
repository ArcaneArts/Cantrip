import { generateAccountMasterKey } from "@cantrip/crypto";
import type { ClientSessionContext } from "./client-session";
import { describe, expect, it } from "vitest";

import { ClientEncryptionService } from "./client-encryption";
import {
  openDiscoveredMcpServerCreate,
  openModelProviderAccountWireSummary,
  protectMcpServerCreate,
  protectModelProviderAccountCreate,
  protectModelProviderCreate,
  protectModelProviderUpdate,
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
  it.each(["CodeGraph", "CANTRIP"])(
    "rejects the managed %s name before encryption",
    async (name) => {
      await expect(
        protectMcpServerCreate({
          name,
          enabled: true,
          transport: "stdio",
          command: "codegraph",
          args: [],
          environment: {},
        }),
      ).rejects.toThrow("reserved");
    },
  );

  it("opens a worker-sealed discovery candidate without changing its ciphertext", async () => {
    const options = unlockedOptions();
    const encrypted = await protectMcpServerCreate(
      {
        name: "discovered_private",
        enabled: true,
        transport: "http",
        url: "http://127.0.0.1:4141/private",
        bearerTokenEnvironmentVariable: null,
        headers: { Authorization: "Bearer private-discovery-secret" },
        environmentHeaders: {},
      },
      "worker-1",
      options,
    );

    const opened = await openDiscoveredMcpServerCreate(encrypted, options);
    expect(opened.encrypted).toEqual(encrypted);
    expect(opened.configuration).toMatchObject({
      name: "discovered_private",
      transport: "http",
      headers: { Authorization: "Bearer private-discovery-secret" },
    });
    expect(JSON.stringify(encrypted)).not.toContain("private-discovery-secret");
  });
});

describe("protected provider payloads", () => {
  it("creates an Ollama provider without retaining a plaintext API-key field", async () => {
    const encrypted = await protectModelProviderCreate({
      name: "Ollama",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: null,
    });

    expect(encrypted).toMatchObject({
      name: "Ollama",
      kind: "ollama",
      protectedApiKey: null,
    });
    expect(Object.hasOwn(encrypted, "apiKey")).toBe(false);
  });

  it("encrypts provider API-key updates without retaining plaintext", async () => {
    const apiKey = "provider-secret-value";
    const encrypted = await protectModelProviderUpdate(
      crypto.randomUUID(),
      {
        name: "OpenAI-compatible",
        kind: "openai-compatible",
        baseUrl: "https://api.example.test/v1",
        apiKey,
      },
      unlockedOptions(),
    );

    expect(Object.hasOwn(encrypted, "apiKey")).toBe(false);
    expect(encrypted.protectedApiKey).not.toBeNull();
    expect(JSON.stringify(encrypted)).not.toContain(apiKey);
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
