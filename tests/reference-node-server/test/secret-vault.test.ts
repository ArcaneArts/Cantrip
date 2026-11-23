import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ServerConfig } from "../src/config.js";
import {
  resolveSecretVault,
  SecretVault,
} from "../src/security/secret-vault.js";

const key = (fill: number) => Buffer.alloc(32, fill);

describe("secret envelope encryption", () => {
  it("authenticates ciphertext and resource context", () => {
    const vault = new SecretVault({
      activeKeyId: "primary",
      keys: [{ id: "primary", key: key(1) }],
    });
    const encrypted = vault.encrypt("provider-secret", "provider:one");

    expect(encrypted).not.toContain("provider-secret");
    expect(vault.decrypt(encrypted, "provider:one")).toBe("provider-secret");
    expect(() => vault.decrypt(encrypted, "provider:two")).toThrow();
  });

  it("reads old keys and identifies envelopes that need rotation", () => {
    const oldVault = new SecretVault({
      activeKeyId: "old",
      keys: [{ id: "old", key: key(2) }],
    });
    const encrypted = oldVault.encrypt("rotate-me", "provider:one");
    const rotatingVault = new SecretVault({
      activeKeyId: "new",
      keys: [
        { id: "new", key: key(3) },
        { id: "old", key: key(2) },
      ],
    });

    expect(rotatingVault.decrypt(encrypted, "provider:one")).toBe("rotate-me");
    expect(rotatingVault.needsRotation(encrypted)).toBe(true);
  });

  it("persists a private local development key", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "cantrip-vault-"));
    const config = {
      dataDirectory,
      deploymentMode: "local",
    } as ServerConfig;
    try {
      const first = await resolveSecretVault(config);
      const encrypted = first.encrypt("survives restart", "provider:one");
      const second = await resolveSecretVault(config);
      expect(second.decrypt(encrypted, "provider:one")).toBe(
        "survives restart",
      );
      const file = path.join(dataDirectory, "secret-encryption-key.json");
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
        id: "local-v1",
        version: 1,
      });
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});
