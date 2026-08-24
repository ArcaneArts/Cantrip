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

interface StoredWorkerEncryptionKeyV1 {
  version: 1;
  serverId: string;
  ownerId: string | null;
  workerId: string;
  principalId: string;
  publicKey: EncryptionPublicKey;
  privateKey: string;
  acceptedRevisions: Partial<Record<WorkerEncryptionComponentScope, number>>;
}

interface StoredWorkerEncryptionKey {
  version: 2;
  serverUrl: string;
  serverId: string | null;
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

function canonicalServerUrl(
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

function isLoopbackHostname(hostname: string): boolean {
  return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname);
}

function isPortlessLoopbackPolicyTransition(
  storedServerUrl: string,
  expectedServerUrl: string,
): boolean {
  const stored = new URL(storedServerUrl);
  const expected = new URL(expectedServerUrl);
  return (
    isLoopbackHostname(stored.hostname) &&
    stored.protocol === expected.protocol &&
    stored.hostname === expected.hostname &&
    stored.port === "" &&
    expected.port !== ""
  );
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
    serverUrl: string;
    workerId: string;
  },
): StoredWorkerEncryptionKey {
  if (!value || typeof value !== "object") {
    throw new WorkerEncryptionError(
      "corrupt-key-record",
      "The stored worker encryption key is invalid.",
    );
  }
  const record = value as Partial<
    StoredWorkerEncryptionKey | StoredWorkerEncryptionKeyV1
  >;
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
    ![1, 2].includes(record.version ?? 0) ||
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
  const storedTransportUrl =
    record.version === 1
      ? (record as Partial<StoredWorkerEncryptionKeyV1>).serverId
      : (record as Partial<StoredWorkerEncryptionKey>).serverUrl;
  if (typeof storedTransportUrl !== "string") {
    throw new WorkerEncryptionError(
      "corrupt-key-record",
      "The stored worker encryption server transport is invalid.",
    );
  }
  let canonicalStoredServerUrl: string;
  try {
    canonicalStoredServerUrl = canonicalServerUrl(
      storedTransportUrl,
      expected.allowLoopbackServerPortChange,
    );
  } catch {
    throw new WorkerEncryptionError(
      "corrupt-key-record",
      "The stored worker encryption server identity is invalid.",
    );
  }
  // A portless loopback binding can only have been written by the explicit
  // development policy. Permit it to reopen under the exact-port policy; the
  // exact current port is persisted only after bootstrap verifies the server.
  const loopbackPolicyTransition =
    !expected.allowLoopbackServerPortChange &&
    isPortlessLoopbackPolicyTransition(
      canonicalStoredServerUrl,
      expected.serverUrl,
    );
  if (
    (!loopbackPolicyTransition &&
      canonicalStoredServerUrl !== expected.serverUrl) ||
    record.workerId !== expected.workerId
  ) {
    throw new WorkerEncryptionError(
      "identity-mismatch",
      "The stored worker encryption key belongs to another server or worker identity.",
    );
  }
  const serverId =
    record.version === 2
      ? (record as Partial<StoredWorkerEncryptionKey>).serverId
      : null;
  if (
    serverId !== null &&
    (typeof serverId !== "string" ||
      !workerEncryptionBootstrapResultSchema.shape.serverId.safeParse(serverId)
        .success)
  ) {
    throw new WorkerEncryptionError(
      "corrupt-key-record",
      "The stored worker encryption logical server identity is invalid.",
    );
  }
  return {
    version: 2,
    serverUrl: expected.serverUrl,
    serverId,
    ownerId: record.ownerId,
    workerId: record.workerId,
    principalId: record.principalId,
    publicKey,
    privateKey: record.privateKey,
    acceptedRevisions: record.acceptedRevisions,
  };
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
    Map<number, ComponentKeyEntry>
  >();
  readonly #acceptedRevisions = new Map<
    WorkerEncryptionComponentScope,
    number
  >();
  #ownerId: string | null;
  #boundServerId: string | null;
  #bootstrapGeneration = 0;
  #serverId: string | null = null;
  #status: WorkerEncryptionStatus;

  private constructor(
    private readonly pathname: string,
    private readonly serverUrl: string,
    private readonly transportServerUrl: string,
    private readonly allowLoopbackServerIdentityChange: boolean,
    private readonly workerId: string,
    private readonly principalId: string,
    private readonly publicKey: EncryptionPublicKey,
    private readonly keyPair: CryptoKeyPair,
    ownerId: string | null,
    boundServerId: string | null,
    acceptedRevisions: StoredWorkerEncryptionKey["acceptedRevisions"],
  ) {
    this.#ownerId = ownerId;
    this.#boundServerId = boundServerId;
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
    allowLoopbackServerIdentityChange?: boolean;
    allowLoopbackServerPortChange?: boolean;
    dataDirectory: string;
    serverUrl: string;
    workerId: string;
  }): Promise<WorkerEncryptionService> {
    const serverUrl = canonicalServerUrl(input.serverUrl);
    const allowLoopbackServerPortChange =
      input.allowLoopbackServerPortChange ?? false;
    const transportServerUrl = canonicalServerUrl(
      serverUrl,
      allowLoopbackServerPortChange,
    );
    const allowLoopbackServerIdentityChange =
      (input.allowLoopbackServerIdentityChange ?? false) &&
      isLoopbackHostname(new URL(serverUrl).hostname);
    const pathname = workerEncryptionKeyPath(input.dataDirectory);
    if (existsSync(pathname)) {
      const record = parseRecord(readRecord(pathname), {
        allowLoopbackServerPortChange,
        serverUrl: transportServerUrl,
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
        return new WorkerEncryptionService(
          pathname,
          serverUrl,
          transportServerUrl,
          allowLoopbackServerIdentityChange,
          input.workerId,
          record.principalId,
          record.publicKey,
          keyPair,
          record.ownerId,
          record.serverId,
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
        version: 2,
        serverUrl: transportServerUrl,
        serverId: null,
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
      transportServerUrl,
      allowLoopbackServerIdentityChange,
      input.workerId,
      principalId,
      publicKey,
      keyPair,
      null,
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
    if (!this.#serverId) {
      throw new WorkerEncryptionError(
        "principal-unavailable",
        "Worker encryption has not verified the logical server identity.",
      );
    }
    return this.#serverId;
  }

  componentKey(
    component: WorkerEncryptionComponentScope,
    keyRevision?: number,
  ): {
    key: Uint8Array;
    keyRevision: number;
  } {
    const scope = workerEncryptionComponentScopeSchema.parse(component);
    const revisions = this.#componentKeys.get(scope);
    const selectedRevision =
      keyRevision ??
      (revisions ? Math.max(...revisions.keys()) : Number.NEGATIVE_INFINITY);
    const entry = revisions?.get(selectedRevision);
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
    const generation = ++this.#bootstrapGeneration;
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
      if (generation === this.#bootstrapGeneration) {
        this.recordRefreshError(error);
      }
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
      if (generation === this.#bootstrapGeneration) {
        if (response.status >= 400 && response.status < 500) {
          this.#serverId = null;
          this.clearComponentKeys();
        }
        this.recordRefreshError(message);
      }
      throw new WorkerEncryptionError("server-unavailable", message);
    }
    const payload = await response.json().catch(() => null);
    return this.acceptBootstrapGeneration(payload, generation);
  }

  async acceptBootstrap(input: unknown): Promise<WorkerEncryptionStatus> {
    const generation = ++this.#bootstrapGeneration;
    return this.acceptBootstrapGeneration(input, generation);
  }

  private async acceptBootstrapGeneration(
    input: unknown,
    generation: number,
  ): Promise<WorkerEncryptionStatus> {
    try {
      return await this.applyBootstrap(input, generation);
    } catch (error) {
      if (generation !== this.#bootstrapGeneration) return this.status();
      this.#serverId = null;
      this.clearComponentKeys();
      this.recordRefreshError(error);
      throw error;
    }
  }

  private async applyBootstrap(
    input: unknown,
    generation: number,
  ): Promise<WorkerEncryptionStatus> {
    if (generation !== this.#bootstrapGeneration) return this.status();
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
    const serverIdentityChanged = Boolean(
      this.#boundServerId && this.#boundServerId !== result.serverId,
    );
    if (serverIdentityChanged && !this.allowLoopbackServerIdentityChange) {
      throw new WorkerEncryptionError(
        "identity-mismatch",
        "The worker encryption key belongs to another logical server.",
      );
    }
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
    const acceptedRevisions = serverIdentityChanged
      ? new Map<WorkerEncryptionComponentScope, number>()
      : new Map(this.#acceptedRevisions);
    if (principal.state !== "approved") {
      if (
        !(await this.persistIdentity(
          {
            acceptedRevisions,
            ownerId: result.ownerId,
            serverId: result.serverId,
          },
          generation,
        ))
      ) {
        return this.status();
      }
      this.#ownerId = result.ownerId;
      this.#boundServerId = result.serverId;
      this.#serverId = result.serverId;
      this.clearComponentKeys();
      this.#acceptedRevisions.clear();
      for (const [component, revision] of acceptedRevisions) {
        this.#acceptedRevisions.set(component, revision);
      }
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

    const grantsByComponent = new Map<
      WorkerEncryptionComponentScope,
      Map<number, WorkerEncryptionBootstrapResult["grants"][number]>
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
      const revisions = grantsByComponent.get(component) ?? new Map();
      revisions.set(grant.keyRevision, grant);
      grantsByComponent.set(component, revisions);
    }
    for (const [component, revisions] of grantsByComponent) {
      const latestRevision = Math.max(...revisions.keys());
      const acceptedRevision = acceptedRevisions.get(component) ?? 0;
      if (latestRevision < acceptedRevision) {
        throw new WorkerEncryptionError(
          "principal-unavailable",
          `The ${component} grant revision was rolled back.`,
        );
      }
    }

    const replacement = new Map<
      WorkerEncryptionComponentScope,
      Map<number, ComponentKeyEntry>
    >();
    try {
      for (const [component, grants] of grantsByComponent) {
        const revisions = new Map<number, ComponentKeyEntry>();
        replacement.set(component, revisions);
        for (const grant of grants.values()) {
          if (grant.wrappedKey.purpose !== "worker-component-key") continue;
          revisions.set(grant.keyRevision, {
            key: await unwrapComponentKeyForWorker({
              ownerId: result.ownerId,
              grant: grant.wrappedKey,
              workerKeyPair: this.keyPair,
            }),
            keyRevision: grant.keyRevision,
          });
        }
      }
    } catch {
      for (const revisions of replacement.values()) {
        for (const entry of revisions.values()) clearSensitiveBytes(entry.key);
      }
      throw new WorkerEncryptionError(
        "principal-unavailable",
        "A worker encryption grant could not be opened.",
      );
    }
    for (const [component, revisions] of replacement) {
      acceptedRevisions.set(component, Math.max(...revisions.keys()));
    }
    try {
      if (
        !(await this.persistIdentity(
          {
            acceptedRevisions,
            ownerId: result.ownerId,
            serverId: result.serverId,
          },
          generation,
        ))
      ) {
        for (const revisions of replacement.values()) {
          for (const entry of revisions.values()) {
            clearSensitiveBytes(entry.key);
          }
        }
        return this.status();
      }
    } catch (error) {
      for (const revisions of replacement.values()) {
        for (const entry of revisions.values()) clearSensitiveBytes(entry.key);
      }
      throw error;
    }
    this.clearComponentKeys();
    this.#acceptedRevisions.clear();
    for (const [component, revision] of acceptedRevisions) {
      this.#acceptedRevisions.set(component, revision);
    }
    for (const [component, revisions] of replacement) {
      this.#componentKeys.set(component, revisions);
    }
    this.#ownerId = result.ownerId;
    this.#boundServerId = result.serverId;
    this.#serverId = result.serverId;
    this.#status = workerEncryptionStatusSchema.parse({
      supported: true,
      state: "ready",
      principalId: this.principalId,
      grants: [...this.#componentKeys].map(([component, revisions]) => ({
        component,
        keyRevision: Math.max(...revisions.keys()),
      })),
      lastSyncedAt: new Date().toISOString(),
      error: null,
    });
    return this.status();
  }

  lock(): void {
    this.#bootstrapGeneration += 1;
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

  private async persistIdentity(
    input: {
      acceptedRevisions?: Map<WorkerEncryptionComponentScope, number>;
      ownerId?: string | null;
      serverId?: string | null;
    },
    generation: number,
  ): Promise<boolean> {
    const privateKey = await exportHpkePrivateKey(this.keyPair.privateKey);
    try {
      // Do not let an older async unwrap/export finish after a newer bootstrap
      // and overwrite its persisted or in-memory identity.
      if (generation !== this.#bootstrapGeneration) return false;
      writeRecord(this.pathname, {
        version: 2,
        serverUrl: this.transportServerUrl,
        serverId: input?.serverId ?? this.#boundServerId,
        ownerId: input?.ownerId ?? this.#ownerId,
        workerId: this.workerId,
        principalId: this.principalId,
        publicKey: this.publicKey,
        privateKey: encodeBase64Url(privateKey),
        acceptedRevisions: Object.fromEntries(
          input?.acceptedRevisions ?? this.#acceptedRevisions,
        ),
      });
      return true;
    } finally {
      clearSensitiveBytes(privateKey);
    }
  }

  private clearComponentKeys(): void {
    for (const revisions of this.#componentKeys.values()) {
      for (const entry of revisions.values()) clearSensitiveBytes(entry.key);
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
      grants: [...this.#componentKeys].map(([component, revisions]) => ({
        component,
        keyRevision: Math.max(...revisions.keys()),
      })),
      lastSyncedAt: this.#status.lastSyncedAt,
      error: message || "Worker encryption refresh failed.",
    });
  }
}
