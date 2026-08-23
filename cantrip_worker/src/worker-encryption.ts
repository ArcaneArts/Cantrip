import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  bytesEqual,
  clearSensitiveBytes,
  decodeBase64Url,
  encodeBase64Url,
  exportHpkePrivateKey,
  exportHpkePublicKey,
  generateHpkeKeyPair,
  importHpkeKeyPair,
  randomBytes,
  unwrapComponentKeyForWorker,
  wrapComponentKeyForWorker,
} from "@cantrip/crypto";
import {
  encryptionPublicKeySchema,
  workerEncryptionBootstrapRequestSchema,
  workerEncryptionBootstrapResultSchema,
  workerEncryptionComponentScopeSchema,
  workerEncryptionStatusSchema,
  type EncryptionPublicKey,
  type WorkerEncryptionBootstrapResult,
  type WorkerEncryptionComponentScope,
  type WorkerEncryptionStatus,
} from "@cantrip/protocol/encryption";

const KEY_FILENAME = "worker-encryption-key.json";

interface StoredWorkerEncryptionKey {
  version: 1;
  serverId: string;
  ownerId: string | null;
  workerId: string;
  principalId: string;
  publicKey: EncryptionPublicKey;
  privateKey: string;
  acceptedRevisions: Partial<Record<WorkerEncryptionComponentScope, number>>;
}

interface ComponentKeyEntry {
  key: Uint8Array;
  keyRevision: number;
}

export class WorkerEncryptionError extends Error {
  constructor(
    readonly code:
      | "corrupt-key-record"
      | "identity-mismatch"
      | "missing-scope"
      | "principal-unavailable"
      | "server-unavailable",
    message: string,
  ) {
    super(message);
    this.name = "WorkerEncryptionError";
  }
}

function canonicalServerId(
  serverUrl: string,
  allowLoopbackServerPortChange = false,
): string {
  const parsed = new URL(serverUrl);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new WorkerEncryptionError(
      "identity-mismatch",
      "Worker encryption requires an HTTP(S) server origin.",
    );
  }
  if (
    allowLoopbackServerPortChange &&
    ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname)
  ) {
    parsed.port = "";
  }
  return parsed.origin;
}

function readRecord(pathname: string): unknown {
  try {
    return JSON.parse(readFileSync(pathname, "utf8"));
  } catch {
    return null;
  }
}

function parseRecord(
  value: unknown,
  expected: {
    allowLoopbackServerPortChange: boolean;
    serverId: string;
    workerId: string;
  },
): StoredWorkerEncryptionKey {
  if (!value || typeof value !== "object") {
    throw new WorkerEncryptionError(
      "corrupt-key-record",
      "The stored worker encryption key is invalid.",
    );
  }
  const record = value as Partial<StoredWorkerEncryptionKey>;
  let publicKey: EncryptionPublicKey;
  try {
    publicKey = encryptionPublicKeySchema.parse(record.publicKey);
  } catch {
    throw new WorkerEncryptionError(
      "corrupt-key-record",
      "The stored worker encryption public key is invalid.",
    );
  }
  if (
    record.version !== 1 ||
    typeof record.serverId !== "string" ||
    typeof record.principalId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      record.principalId,
    ) ||
    typeof record.privateKey !== "string" ||
    (record.ownerId !== null && typeof record.ownerId !== "string") ||
    !record.acceptedRevisions ||
    typeof record.acceptedRevisions !== "object"
  ) {
    throw new WorkerEncryptionError(
      "corrupt-key-record",
      "The stored worker encryption key is invalid.",
    );
  }
  let storedServerId: string;
  try {
    storedServerId = canonicalServerId(
      record.serverId,
      expected.allowLoopbackServerPortChange,
    );
  } catch {
    throw new WorkerEncryptionError(
      "corrupt-key-record",
      "The stored worker encryption server identity is invalid.",
    );
  }
  if (
    storedServerId !== expected.serverId ||
    record.workerId !== expected.workerId
  ) {
    throw new WorkerEncryptionError(
      "identity-mismatch",
      "The stored worker encryption key belongs to another server or worker identity.",
    );
  }
  return { ...record, publicKey } as StoredWorkerEncryptionKey;
}

function writeRecord(pathname: string, record: StoredWorkerEncryptionKey) {
  mkdirSync(path.dirname(pathname), { recursive: true });
  const temporary = `${pathname}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, pathname);
  chmodSync(pathname, 0o600);
}

function publicKeysMatch(
  left: EncryptionPublicKey,
  right: EncryptionPublicKey,
): boolean {
  return (
    left.version === right.version &&
    left.algorithm === right.algorithm &&
    left.format === right.format &&
    left.value === right.value
  );
}

export function workerEncryptionKeyPath(dataDirectory: string): string {
  return path.join(dataDirectory, KEY_FILENAME);
}

export class WorkerEncryptionService {
  readonly #componentKeys = new Map<
    WorkerEncryptionComponentScope,
    ComponentKeyEntry
  >();
  readonly #acceptedRevisions = new Map<
    WorkerEncryptionComponentScope,
    number
  >();
  #ownerId: string | null;
  #status: WorkerEncryptionStatus;

  private constructor(
    private readonly pathname: string,
    private readonly serverUrl: string,
    private readonly serverId: string,
    private readonly workerId: string,
    private readonly principalId: string,
    private readonly publicKey: EncryptionPublicKey,
    private readonly keyPair: CryptoKeyPair,
    ownerId: string | null,
    acceptedRevisions: StoredWorkerEncryptionKey["acceptedRevisions"],
  ) {
    this.#ownerId = ownerId;
    for (const [component, revision] of Object.entries(acceptedRevisions)) {
      const parsedComponent =
        workerEncryptionComponentScopeSchema.parse(component);
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new WorkerEncryptionError(
          "corrupt-key-record",
          "The stored worker encryption revision state is invalid.",
        );
      }
      this.#acceptedRevisions.set(parsedComponent, revision);
    }
    this.#status = workerEncryptionStatusSchema.parse({
      supported: true,
      state: "pending-approval",
      principalId,
      grants: [],
      lastSyncedAt: null,
      error: null,
    });
  }

  static async open(input: {
    allowLoopbackServerPortChange?: boolean;
    dataDirectory: string;
    serverUrl: string;
    workerId: string;
  }): Promise<WorkerEncryptionService> {
    const serverUrl = canonicalServerId(input.serverUrl);
    const allowLoopbackServerPortChange =
      input.allowLoopbackServerPortChange ?? false;
    const serverId = canonicalServerId(
      serverUrl,
      allowLoopbackServerPortChange,
    );
    const pathname = workerEncryptionKeyPath(input.dataDirectory);
    if (existsSync(pathname)) {
      const record = parseRecord(readRecord(pathname), {
        allowLoopbackServerPortChange,
        serverId,
        workerId: input.workerId,
      });
      chmodSync(pathname, 0o600);
      const privateKey = decodeBase64Url(record.privateKey);
      try {
        const keyPair = await importHpkeKeyPair({
          privateKey,
          publicKey: record.publicKey,
        });
        const probe = randomBytes(32);
        let openedProbe: Uint8Array | null = null;
        let keyPairMatches = false;
        try {
          const probeGrant = await wrapComponentKeyForWorker({
            ownerId: record.ownerId ?? "unbound-worker-key",
            workerId: input.workerId,
            component: "chat-content",
            componentKey: probe,
            keyRevision: 1,
            workerPublicKey: record.publicKey,
          });
          openedProbe = await unwrapComponentKeyForWorker({
            ownerId: record.ownerId ?? "unbound-worker-key",
            grant: probeGrant,
            workerKeyPair: keyPair,
          });
          keyPairMatches = bytesEqual(probe, openedProbe);
        } catch {
          throw new WorkerEncryptionError(
            "corrupt-key-record",
            "The stored worker encryption keypair does not match.",
          );
        } finally {
          if (openedProbe) clearSensitiveBytes(openedProbe);
          clearSensitiveBytes(probe);
        }
        if (!keyPairMatches) {
          throw new WorkerEncryptionError(
            "corrupt-key-record",
            "The stored worker encryption keypair does not match.",
          );
        }
        if (record.serverId !== serverId) {
          writeRecord(pathname, { ...record, serverId });
        }
        return new WorkerEncryptionService(
          pathname,
          serverUrl,
          serverId,
          input.workerId,
          record.principalId,
          record.publicKey,
          keyPair,
          record.ownerId,
          record.acceptedRevisions,
        );
      } finally {
        // The imported CryptoKey is retained, but raw key material is not.
        clearSensitiveBytes(privateKey);
      }
    }

    const keyPair = await generateHpkeKeyPair(true);
    const privateKey = await exportHpkePrivateKey(keyPair.privateKey);
    const publicKey = await exportHpkePublicKey(keyPair.publicKey);
    const principalId = randomUUID();
    try {
      writeRecord(pathname, {
        version: 1,
        serverId,
        ownerId: null,
        workerId: input.workerId,
        principalId,
        publicKey,
        privateKey: encodeBase64Url(privateKey),
        acceptedRevisions: {},
      });
    } finally {
      clearSensitiveBytes(privateKey);
    }
    return new WorkerEncryptionService(
      pathname,
      serverUrl,
      serverId,
      input.workerId,
      principalId,
      publicKey,
      keyPair,
      null,
      {},
    );
  }

  registration() {
    return workerEncryptionBootstrapRequestSchema.parse({
      principalId: this.principalId,
      publicKey: this.publicKey,
    });
  }

  status(): WorkerEncryptionStatus {
    return structuredClone(this.#status);
  }

  ownerId(): string {
    if (!this.#ownerId) {
      throw new WorkerEncryptionError(
        "principal-unavailable",
        "Worker encryption has not been bound to an account.",
      );
    }
    return this.#ownerId;
  }

  serverIdentity(): string {
    return this.serverId;
  }

  componentKey(component: WorkerEncryptionComponentScope): {
    key: Uint8Array;
    keyRevision: number;
  } {
    const scope = workerEncryptionComponentScopeSchema.parse(component);
    const entry = this.#componentKeys.get(scope);
    if (!entry) {
      throw new WorkerEncryptionError(
        "missing-scope",
        `This worker does not have an active ${scope} encryption grant.`,
      );
    }
    return { key: new Uint8Array(entry.key), keyRevision: entry.keyRevision };
  }

  async refresh(input: {
    credential: string;
    fetch?: typeof fetch;
  }): Promise<WorkerEncryptionStatus> {
    const fetcher = input.fetch ?? fetch;
    let response: Response;
    try {
      response = await fetcher(
        `${this.serverUrl}/api/internal/workers/encryption/bootstrap`,
        {
          body: JSON.stringify(this.registration()),
          headers: {
            authorization: `Bearer ${input.credential}`,
            "content-type": "application/json",
            "x-cantrip-worker-id": this.workerId,
          },
          method: "POST",
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch (error) {
      this.recordRefreshError(error);
      throw new WorkerEncryptionError(
        "server-unavailable",
        "Could not refresh worker encryption grants.",
      );
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: unknown;
      } | null;
      const message =
        typeof payload?.error === "string"
          ? payload.error
          : `Cantrip Server rejected worker encryption bootstrap with HTTP ${response.status}.`;
      if (response.status >= 400 && response.status < 500) {
        this.clearComponentKeys();
      }
      this.recordRefreshError(message);
      throw new WorkerEncryptionError("server-unavailable", message);
    }
    try {
      return await this.acceptBootstrap(await response.json());
    } catch (error) {
      this.clearComponentKeys();
      this.recordRefreshError(error);
      throw error;
    }
  }

  async acceptBootstrap(input: unknown): Promise<WorkerEncryptionStatus> {
    try {
      return await this.applyBootstrap(input);
    } catch (error) {
      this.clearComponentKeys();
      this.recordRefreshError(error);
      throw error;
    }
  }

  private async applyBootstrap(
    input: unknown,
  ): Promise<WorkerEncryptionStatus> {
    let result: WorkerEncryptionBootstrapResult;
    try {
      result = workerEncryptionBootstrapResultSchema.parse(input);
    } catch {
      throw new WorkerEncryptionError(
        "principal-unavailable",
        "The server returned invalid worker encryption authorization.",
      );
    }
    const principal = result.principal;
    if (
      principal.id !== this.principalId ||
      principal.workerId !== this.workerId ||
      !publicKeysMatch(principal.publicKey, this.publicKey)
    ) {
      throw new WorkerEncryptionError(
        "identity-mismatch",
        "The server returned a different worker encryption identity.",
      );
    }
    if (this.#ownerId && this.#ownerId !== result.ownerId) {
      throw new WorkerEncryptionError(
        "identity-mismatch",
        "The worker encryption key belongs to another account.",
      );
    }
    if (!this.#ownerId) {
      this.#ownerId = result.ownerId;
      await this.persistIdentity();
    }
    if (principal.state !== "approved") {
      this.clearComponentKeys();
      this.#status = workerEncryptionStatusSchema.parse({
        supported: true,
        state:
          principal.state === "pending" ? "pending-approval" : "unavailable",
        principalId: this.principalId,
        grants: [],
        lastSyncedAt: new Date().toISOString(),
        error:
          principal.state === "revoked"
            ? "Worker encryption authorization was revoked."
            : null,
      });
      return this.status();
    }

    const latest = new Map<
      WorkerEncryptionComponentScope,
      WorkerEncryptionBootstrapResult["grants"][number]
    >();
    for (const grant of result.grants) {
      if (
        grant.wrappedKey.purpose !== "worker-component-key" ||
        grant.wrappedKey.workerId !== this.workerId
      ) {
        throw new WorkerEncryptionError(
          "identity-mismatch",
          "A worker encryption grant targets another worker.",
        );
      }
      const component = workerEncryptionComponentScopeSchema.parse(
        grant.component,
      );
      const current = latest.get(component);
      if (!current || grant.keyRevision > current.keyRevision) {
        latest.set(component, grant);
      }
    }
    for (const [component, grant] of latest) {
      const acceptedRevision = this.#acceptedRevisions.get(component) ?? 0;
      if (grant.keyRevision < acceptedRevision) {
        throw new WorkerEncryptionError(
          "principal-unavailable",
          `The ${component} grant revision was rolled back.`,
        );
      }
    }

    const replacement = new Map<
      WorkerEncryptionComponentScope,
      ComponentKeyEntry
    >();
    try {
      for (const [component, grant] of latest) {
        if (grant.wrappedKey.purpose !== "worker-component-key") continue;
        replacement.set(component, {
          key: await unwrapComponentKeyForWorker({
            ownerId: result.ownerId,
            grant: grant.wrappedKey,
            workerKeyPair: this.keyPair,
          }),
          keyRevision: grant.keyRevision,
        });
      }
    } catch {
      for (const entry of replacement.values()) clearSensitiveBytes(entry.key);
      throw new WorkerEncryptionError(
        "principal-unavailable",
        "A worker encryption grant could not be opened.",
      );
    }
    this.clearComponentKeys();
    for (const [component, entry] of replacement) {
      this.#componentKeys.set(component, entry);
      this.#acceptedRevisions.set(component, entry.keyRevision);
    }
    await this.persistIdentity();
    this.#status = workerEncryptionStatusSchema.parse({
      supported: true,
      state: "ready",
      principalId: this.principalId,
      grants: [...this.#componentKeys].map(([component, entry]) => ({
        component,
        keyRevision: entry.keyRevision,
      })),
      lastSyncedAt: new Date().toISOString(),
      error: null,
    });
    return this.status();
  }

  lock(): void {
    this.clearComponentKeys();
    this.#status = workerEncryptionStatusSchema.parse({
      supported: true,
      state: "unavailable",
      principalId: this.principalId,
      grants: [],
      lastSyncedAt: this.#status.lastSyncedAt,
      error: "Worker encryption keys were cleared from memory.",
    });
  }

  private async persistIdentity(): Promise<void> {
    const privateKey = await exportHpkePrivateKey(this.keyPair.privateKey);
    try {
      writeRecord(this.pathname, {
        version: 1,
        serverId: this.serverId,
        ownerId: this.#ownerId,
        workerId: this.workerId,
        principalId: this.principalId,
        publicKey: this.publicKey,
        privateKey: encodeBase64Url(privateKey),
        acceptedRevisions: Object.fromEntries(this.#acceptedRevisions),
      });
    } finally {
      clearSensitiveBytes(privateKey);
    }
  }

  private clearComponentKeys(): void {
    for (const entry of this.#componentKeys.values()) {
      clearSensitiveBytes(entry.key);
    }
    this.#componentKeys.clear();
  }

  private recordRefreshError(error: unknown): void {
    const message = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 500);
    this.#status = workerEncryptionStatusSchema.parse({
      supported: true,
      state: "error",
      principalId: this.principalId,
      grants: [...this.#componentKeys].map(([component, entry]) => ({
        component,
        keyRevision: entry.keyRevision,
      })),
      lastSyncedAt: this.#status.lastSyncedAt,
      error: message || "Worker encryption refresh failed.",
    });
  }
}
