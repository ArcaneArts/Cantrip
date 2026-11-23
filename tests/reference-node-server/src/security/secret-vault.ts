import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SecretEncryptionConfig, ServerConfig } from "../config.js";

const LOCAL_KEY_FILE = "secret-encryption-key.json";

interface SecretEnvelope {
  algorithm: "A256GCM";
  ciphertext: string;
  iv: string;
  keyId: string;
  tag: string;
  version: 1;
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Encrypted secret metadata is malformed.");
  }
  return parsed as Record<string, unknown>;
}

function parseEnvelope(value: string): SecretEnvelope {
  const parsed = parseJsonObject(value);
  if (
    parsed.version !== 1 ||
    parsed.algorithm !== "A256GCM" ||
    typeof parsed.keyId !== "string" ||
    parsed.keyId.length < 1 ||
    parsed.keyId.length > 64 ||
    typeof parsed.iv !== "string" ||
    parsed.iv.length > 100 ||
    typeof parsed.tag !== "string" ||
    parsed.tag.length > 100 ||
    typeof parsed.ciphertext !== "string" ||
    parsed.ciphertext.length < 1 ||
    parsed.ciphertext.length > 1_000_000
  ) {
    throw new Error("Encrypted secret envelope is malformed.");
  }
  return parsed as unknown as SecretEnvelope;
}

function canonicalBase64(value: string, expectedBytes?: number): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.toString("base64") !== value ||
    (expectedBytes !== undefined && decoded.byteLength !== expectedBytes)
  ) {
    throw new Error("Encrypted secret envelope is malformed.");
  }
  return decoded;
}

function localKeyConfig(key: Uint8Array): SecretEncryptionConfig {
  return {
    activeKeyId: "local-v1",
    keys: [{ id: "local-v1", key }],
  };
}

async function readLocalKey(file: string): Promise<SecretEncryptionConfig> {
  const parsed = parseJsonObject(await readFile(file, "utf8"));
  if (
    parsed.version !== 1 ||
    parsed.id !== "local-v1" ||
    typeof parsed.key !== "string"
  ) {
    throw new Error("Local secret encryption key file is malformed.");
  }
  return localKeyConfig(canonicalBase64(parsed.key, 32));
}

async function loadOrCreateLocalKey(
  dataDirectory: string,
): Promise<SecretEncryptionConfig> {
  await mkdir(dataDirectory, { recursive: true });
  const file = path.join(dataDirectory, LOCAL_KEY_FILE);
  try {
    const config = await readLocalKey(file);
    await chmod(file, 0o600);
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const config = localKeyConfig(randomBytes(32));
  const serialized = `${JSON.stringify({
    id: config.activeKeyId,
    key: Buffer.from(config.keys[0]!.key).toString("base64"),
    version: 1,
  })}\n`;
  try {
    await writeFile(file, serialized, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readLocalKey(file);
  }
}

export class SecretVault {
  readonly #activeKeyId: string;
  readonly #keys: Map<string, Buffer>;

  constructor(config: SecretEncryptionConfig) {
    if (
      config.keys.length < 1 ||
      config.keys.length > 16 ||
      config.keys.some(
        ({ id, key }) =>
          !/^[A-Za-z0-9._-]{1,64}$/u.test(id) || key.byteLength !== 32,
      ) ||
      new Set(config.keys.map(({ id }) => id)).size !== config.keys.length
    ) {
      throw new Error("Secret encryption keyring is invalid.");
    }
    this.#activeKeyId = config.activeKeyId;
    this.#keys = new Map(
      config.keys.map(({ id, key }) => [id, Buffer.from(key)] as const),
    );
    if (!this.#keys.has(this.#activeKeyId)) {
      throw new Error("Active encryption key is not present in the keyring.");
    }
  }

  get activeKeyId(): string {
    return this.#activeKeyId;
  }

  encrypt(value: string, context: string): string {
    const key = this.#keys.get(this.#activeKeyId)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return JSON.stringify({
      algorithm: "A256GCM",
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      keyId: this.#activeKeyId,
      tag: cipher.getAuthTag().toString("base64"),
      version: 1,
    });
  }

  decrypt(envelope: string, context: string): string {
    const parsed = parseEnvelope(envelope);
    const key = this.#keys.get(parsed.keyId);
    if (!key) {
      throw new Error(
        `Encrypted secret references unavailable key ${parsed.keyId}.`,
      );
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      canonicalBase64(parsed.iv, 12),
    );
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(canonicalBase64(parsed.tag, 16));
    return Buffer.concat([
      decipher.update(canonicalBase64(parsed.ciphertext)),
      decipher.final(),
    ]).toString("utf8");
  }

  needsRotation(envelope: string): boolean {
    const parsed = parseEnvelope(envelope);
    return parsed.keyId !== this.#activeKeyId;
  }
}

export async function resolveSecretVault(
  config: ServerConfig,
): Promise<SecretVault> {
  const encryption =
    config.secretEncryption ??
    (config.deploymentMode === "hosted"
      ? null
      : await loadOrCreateLocalKey(config.dataDirectory));
  if (!encryption) {
    throw new Error(
      "Hosted deployments require a configured secret encryption keyring.",
    );
  }
  return new SecretVault(encryption);
}
