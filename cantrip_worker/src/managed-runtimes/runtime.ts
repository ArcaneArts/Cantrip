import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import {
  managedWebRuntimeArtifactSchema,
  managedWebRuntimeReleaseManifestSchema,
  managedWebRuntimeStatusSchema,
  type ManagedWebRuntimeArtifact,
  type ManagedWebRuntimeComponent,
  type ManagedWebRuntimeFailure,
  type ManagedWebRuntimeReleaseManifest,
  type ManagedWebRuntimeStatus,
} from "@cantrip/protocol";

import { extractManagedRuntimeArchive } from "./archive.js";

const MANIFEST_LIMIT_BYTES = 2_000_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const LOCK_WAIT_MS = 30_000;
const LOCK_STALE_MS = 30 * 60_000;
const PARTIAL_STALE_MS = 24 * 60 * 60_000;

interface RuntimePointerEntry {
  archiveSha256: string;
  version: string;
}

interface RuntimePointer extends RuntimePointerEntry {
  component: ManagedWebRuntimeComponent;
  previous: RuntimePointerEntry | null;
  schemaVersion: 1;
  verifiedAt: string;
}

export interface ManagedRuntimeProbeContext {
  artifact: ManagedWebRuntimeArtifact;
  runtimeDirectory: string;
}

export interface ManagedRuntimeInstallerOptions {
  architecture?: string;
  component: ManagedWebRuntimeComponent;
  dataDirectory: string;
  fetch?: typeof fetch;
  manifestUrl: string;
  now?: () => Date;
  platform?: NodeJS.Platform;
  publicKeys: Readonly<Record<string, string | Buffer>>;
  validateInventory(context: ManagedRuntimeProbeContext): Promise<void>;
  probe(context: ManagedRuntimeProbeContext): Promise<void>;
}

class ManagedRuntimeInstallError extends Error {
  constructor(
    readonly category: ManagedWebRuntimeFailure["category"],
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

function normalizedPlatform(
  platform: NodeJS.Platform,
): "darwin" | "linux" | "win32" | null {
  if (platform === "darwin" || platform === "linux" || platform === "win32") {
    return platform;
  }
  return null;
}

function normalizedArchitecture(architecture: string): "arm64" | "x64" | null {
  return architecture === "arm64" || architecture === "x64"
    ? architecture
    : null;
}

function runtimeEntry(value: unknown): RuntimePointerEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.version !== "string" ||
    entry.version.length < 1 ||
    entry.version.length > 100 ||
    typeof entry.archiveSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(entry.archiveSha256)
  ) {
    return null;
  }
  return { version: entry.version, archiveSha256: entry.archiveSha256 };
}

function parsePointer(
  value: unknown,
  component: ManagedWebRuntimeComponent,
): RuntimePointer | null {
  const entry = runtimeEntry(value);
  if (!entry || !value || typeof value !== "object") return null;
  const pointer = value as Record<string, unknown>;
  const previous =
    pointer.previous === null ? null : runtimeEntry(pointer.previous);
  if (
    pointer.schemaVersion !== 1 ||
    pointer.component !== component ||
    typeof pointer.verifiedAt !== "string" ||
    !Number.isFinite(Date.parse(pointer.verifiedAt)) ||
    (pointer.previous !== null && !previous)
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    component,
    ...entry,
    previous,
    verifiedAt: pointer.verifiedAt,
  };
}

function signaturePayload(artifact: ManagedWebRuntimeArtifact): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: artifact.schemaVersion,
      component: artifact.component,
      version: artifact.version,
      platform: artifact.platform,
      architecture: artifact.architecture,
      archiveFormat: artifact.archiveFormat,
      downloadUrl: artifact.downloadUrl,
      sha256: artifact.sha256,
      signingKeyId: artifact.signingKeyId,
      compressedBytes: artifact.compressedBytes,
      extractedBytes: artifact.extractedBytes,
      licenseManifest: artifact.licenseManifest,
      sourceManifest: artifact.sourceManifest,
      ...(artifact.minimumOs ? { minimumOs: artifact.minimumOs } : {}),
      ...(artifact.minimumKernel
        ? { minimumKernel: artifact.minimumKernel }
        : {}),
      ...(artifact.minimumLibc ? { minimumLibc: artifact.minimumLibc } : {}),
    }),
    "utf8",
  );
}

export function managedRuntimeArtifactSignaturePayload(
  artifact: ManagedWebRuntimeArtifact,
): Buffer {
  return signaturePayload(managedWebRuntimeArtifactSchema.parse(artifact));
}

export function selectManagedRuntimeArtifact(
  manifest: ManagedWebRuntimeReleaseManifest,
  component: ManagedWebRuntimeComponent,
  platform: NodeJS.Platform,
  architecture: string,
): ManagedWebRuntimeArtifact | null {
  const targetPlatform = normalizedPlatform(platform);
  const targetArchitecture = normalizedArchitecture(architecture);
  if (!targetPlatform || !targetArchitecture) return null;
  return (
    manifest.artifacts.find(
      (artifact) =>
        artifact.component === component &&
        artifact.platform === targetPlatform &&
        artifact.architecture === targetArchitecture,
    ) ?? null
  );
}

async function readBoundedResponse(
  response: Response,
  limit: number,
): Promise<Buffer> {
  if (!response.ok) {
    throw new ManagedRuntimeInstallError(
      "download",
      `Managed runtime request failed with HTTP ${response.status}.`,
      response.status >= 500 || response.status === 429,
    );
  }
  const contentLength = response.headers.get("content-length");
  const declared = contentLength === null ? null : Number(contentLength);
  if (declared !== null && Number.isFinite(declared) && declared > limit) {
    throw new ManagedRuntimeInstallError(
      "download",
      "Managed runtime response exceeds its byte limit.",
      false,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new ManagedRuntimeInstallError(
        "download",
        "Managed runtime response exceeds its byte limit.",
        false,
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

async function atomicJsonWrite(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new ManagedRuntimeInstallError(
      "disk",
      "Managed runtime storage is not a private directory.",
      false,
    );
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    entry.uid !== process.getuid()
  ) {
    throw new ManagedRuntimeInstallError(
      "disk",
      "Managed runtime storage has unexpected ownership.",
      false,
    );
  }
  if (process.platform !== "win32") await chmod(directory, 0o700);
}

function boundedFailure(error: unknown, now: Date): ManagedWebRuntimeFailure {
  if (error instanceof ManagedRuntimeInstallError) {
    return {
      category: error.category,
      message: error.message.slice(0, 1_000),
      retryable: error.retryable,
      failedAt: now.toISOString(),
    };
  }
  return {
    category: "unknown",
    message: (error instanceof Error ? error.message : String(error)).slice(
      0,
      1_000,
    ),
    retryable: true,
    failedAt: now.toISOString(),
  };
}

export class ManagedRuntimeInstaller {
  readonly #architecture: string;
  readonly #component: ManagedWebRuntimeComponent;
  readonly #fetch: typeof fetch;
  readonly #manifestUrl: string;
  readonly #now: () => Date;
  readonly #options: ManagedRuntimeInstallerOptions;
  readonly #platform: NodeJS.Platform;
  readonly #root: string;
  #activeArchiveSha256: string | null = null;
  #operation: Promise<ManagedWebRuntimeStatus> | null = null;
  #status: ManagedWebRuntimeStatus;

  constructor(options: ManagedRuntimeInstallerOptions) {
    const manifestUrl = new URL(options.manifestUrl);
    if (manifestUrl.protocol !== "https:") {
      throw new Error("Managed runtime manifests must use HTTPS.");
    }
    this.#options = options;
    this.#architecture = options.architecture ?? process.arch;
    this.#component = options.component;
    this.#fetch = options.fetch ?? fetch;
    this.#manifestUrl = manifestUrl.href;
    this.#now = options.now ?? (() => new Date());
    this.#platform = options.platform ?? process.platform;
    this.#root = path.join(
      options.dataDirectory,
      "managed-runtimes",
      options.component,
    );
    const supported =
      normalizedPlatform(this.#platform) !== null &&
      normalizedArchitecture(this.#architecture) !== null;
    this.#status = managedWebRuntimeStatusSchema.parse({
      component: options.component,
      supported,
      state: supported ? "checking" : "unsupported",
      installedVersion: null,
      previousVersion: null,
      latestVersion: null,
      lastCheckedAt: null,
      progress: null,
      failure: null,
    });
  }

  status(): ManagedWebRuntimeStatus {
    return structuredClone(this.#status);
  }

  runtimeDirectory(): string | null {
    return this.#activeArchiveSha256
      ? this.#versionDirectory(this.#activeArchiveSha256)
      : null;
  }

  prepare(): Promise<ManagedWebRuntimeStatus> {
    if (!this.#status.supported) return Promise.resolve(this.status());
    if (this.#operation) return this.#operation;
    this.#operation = this.#prepare().finally(() => {
      this.#operation = null;
    });
    return this.#operation;
  }

  async rollback(): Promise<ManagedWebRuntimeStatus> {
    await this.#ensureStorage();
    return await this.#withLock(async () => {
      const current = await this.#loadPointer();
      if (!current?.previous) return this.status();
      const previousDirectory = this.#versionDirectory(
        current.previous.archiveSha256,
      );
      await this.#requireDirectory(previousDirectory);
      const next: RuntimePointer = {
        schemaVersion: 1,
        component: this.#component,
        ...current.previous,
        previous: {
          version: current.version,
          archiveSha256: current.archiveSha256,
        },
        verifiedAt: this.#now().toISOString(),
      };
      await atomicJsonWrite(this.#pointerPath(), next);
      this.#applyPointer(next, "ready", null);
      return this.status();
    });
  }

  async #prepare(): Promise<ManagedWebRuntimeStatus> {
    try {
      await this.#ensureStorage();
      const current = await this.#loadPointer();
      if (current) this.#applyPointer(current, "checking", null);
      return await this.#withLock(async () => {
        const manifest = await this.#fetchManifest();
        const artifact = selectManagedRuntimeArtifact(
          manifest,
          this.#component,
          this.#platform,
          this.#architecture,
        );
        const checkedAt = this.#now().toISOString();
        if (!artifact) {
          this.#status = managedWebRuntimeStatusSchema.parse({
            ...this.#status,
            supported: false,
            state: "unsupported",
            lastCheckedAt: checkedAt,
            progress: null,
            failure: {
              category: "compatibility",
              message: `No ${this.#component} runtime is published for ${this.#platform}-${this.#architecture}.`,
              retryable: false,
              failedAt: checkedAt,
            },
          });
          return this.status();
        }
        this.#status = managedWebRuntimeStatusSchema.parse({
          ...this.#status,
          latestVersion: artifact.version,
          lastCheckedAt: checkedAt,
          failure: null,
        });
        const selected = await this.#loadPointer();
        if (
          selected?.version === artifact.version &&
          selected.archiveSha256 === artifact.sha256
        ) {
          await this.#verifyInstalledRuntime(selected, artifact);
          this.#applyPointer(selected, "ready", null);
          await this.#cleanup(selected);
          return this.status();
        }
        await this.#install(artifact, selected);
        return this.status();
      });
    } catch (error) {
      const failure = boundedFailure(error, this.#now());
      this.#status = managedWebRuntimeStatusSchema.parse({
        ...this.#status,
        state: this.#status.installedVersion ? "degraded" : "failed",
        progress: null,
        failure,
      });
      return this.status();
    }
  }

  async #fetchManifest(): Promise<ManagedWebRuntimeReleaseManifest> {
    this.#progress("manifest", 0, 0);
    let response: Response;
    try {
      response = await this.#fetch(this.#manifestUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new ManagedRuntimeInstallError(
        "download",
        `Managed runtime manifest is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
    if (response.url && !response.url.startsWith("https://")) {
      throw new ManagedRuntimeInstallError(
        "download",
        "Managed runtime manifest redirected outside HTTPS.",
        false,
      );
    }
    const body = await readBoundedResponse(response, MANIFEST_LIMIT_BYTES);
    try {
      return managedWebRuntimeReleaseManifestSchema.parse(
        JSON.parse(body.toString("utf8")),
      );
    } catch (error) {
      throw new ManagedRuntimeInstallError(
        "integrity",
        `Managed runtime manifest is invalid: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
    }
  }

  async #install(
    artifact: ManagedWebRuntimeArtifact,
    current: RuntimePointer | null,
  ): Promise<void> {
    this.#status = managedWebRuntimeStatusSchema.parse({
      ...this.#status,
      state: current ? "updating" : "installing",
      failure: null,
    });
    const staging = path.join(
      this.#root,
      "staging",
      `${artifact.sha256}.${process.pid}`,
    );
    const archive = path.join(
      this.#root,
      "downloads",
      `${artifact.sha256}.partial`,
    );
    await rm(staging, { recursive: true, force: true });
    await rm(archive, { force: true });
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      await this.#download(artifact, archive);
      await this.#verifyArtifact(artifact, archive);
      this.#progress("extract", 0, artifact.extractedBytes);
      try {
        await extractManagedRuntimeArchive(
          archive,
          artifact.archiveFormat,
          staging,
          {
            maxExpandedBytes: artifact.extractedBytes,
          },
        );
      } catch (error) {
        throw new ManagedRuntimeInstallError(
          "archive",
          `Managed runtime archive is invalid: ${error instanceof Error ? error.message : String(error)}`,
          false,
        );
      }
      this.#progress(
        "inventory",
        artifact.extractedBytes,
        artifact.extractedBytes,
      );
      await this.#runInventory(staging, artifact);
      this.#progress("probe", artifact.extractedBytes, artifact.extractedBytes);
      await this.#runProbe(staging, artifact);
      const promoted = this.#versionDirectory(artifact.sha256);
      this.#progress(
        "promote",
        artifact.extractedBytes,
        artifact.extractedBytes,
      );
      const promotedEntry = await lstat(promoted).catch(() => null);
      let promotedByOperation = false;
      if (promotedEntry) {
        const retained =
          current?.archiveSha256 === artifact.sha256 ||
          current?.previous?.archiveSha256 === artifact.sha256;
        if (retained) {
          await this.#requireDirectory(promoted);
          await rm(staging, { recursive: true, force: true });
        } else {
          await rm(promoted, { recursive: true, force: true });
          await rename(staging, promoted);
          promotedByOperation = true;
        }
      } else {
        await rename(staging, promoted);
        promotedByOperation = true;
      }
      try {
        await this.#runInventory(promoted, artifact);
        await this.#runProbe(promoted, artifact);
      } catch (error) {
        if (promotedByOperation) {
          await rm(promoted, { recursive: true, force: true });
        }
        throw error;
      }
      const pointer: RuntimePointer = {
        schemaVersion: 1,
        component: this.#component,
        version: artifact.version,
        archiveSha256: artifact.sha256,
        previous: current
          ? { version: current.version, archiveSha256: current.archiveSha256 }
          : null,
        verifiedAt: this.#now().toISOString(),
      };
      await atomicJsonWrite(this.#pointerPath(), pointer);
      this.#applyPointer(pointer, "ready", null);
      await this.#cleanup(pointer);
    } finally {
      await rm(archive, { force: true });
      await rm(staging, { recursive: true, force: true });
    }
  }

  async #download(
    artifact: ManagedWebRuntimeArtifact,
    destination: string,
  ): Promise<void> {
    this.#progress("download", 0, artifact.compressedBytes);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    timer.unref();
    try {
      const response = await this.#fetch(artifact.downloadUrl, {
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new ManagedRuntimeInstallError(
          "download",
          `Managed runtime download failed with HTTP ${response.status}.`,
          response.status >= 500 || response.status === 429,
        );
      }
      if (response.url && !response.url.startsWith("https://")) {
        throw new ManagedRuntimeInstallError(
          "download",
          "Managed runtime artifact redirected outside HTTPS.",
          false,
        );
      }
      const contentLength = response.headers.get("content-length");
      const declared = contentLength === null ? null : Number(contentLength);
      if (
        declared !== null &&
        Number.isFinite(declared) &&
        declared !== artifact.compressedBytes
      ) {
        throw new ManagedRuntimeInstallError(
          "integrity",
          "Managed runtime artifact size does not match its manifest.",
          false,
        );
      }
      let received = 0;
      const reader = response.body.getReader();
      const handle = await open(destination, "wx", 0o600);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = value;
          received += chunk.byteLength;
          if (received > artifact.compressedBytes) {
            await reader.cancel();
            throw new ManagedRuntimeInstallError(
              "integrity",
              "Managed runtime artifact exceeds its declared size.",
              false,
            );
          }
          this.#progress("download", received, artifact.compressedBytes);
          await handle.write(chunk);
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (received !== artifact.compressedBytes) {
        throw new ManagedRuntimeInstallError(
          "integrity",
          "Managed runtime artifact is shorter than its declared size.",
          false,
        );
      }
    } catch (error) {
      if (error instanceof ManagedRuntimeInstallError) throw error;
      throw new ManagedRuntimeInstallError(
        "download",
        `Managed runtime download failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async #verifyArtifact(
    artifact: ManagedWebRuntimeArtifact,
    archive: string,
  ): Promise<void> {
    this.#progress(
      "verify",
      artifact.compressedBytes,
      artifact.compressedBytes,
    );
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    const digest = hash.digest("hex");
    if (digest !== artifact.sha256) {
      throw new ManagedRuntimeInstallError(
        "integrity",
        "Managed runtime artifact digest does not match its manifest.",
        false,
      );
    }
    const key = this.#options.publicKeys[artifact.signingKeyId];
    if (!key) {
      throw new ManagedRuntimeInstallError(
        "signature",
        `Managed runtime signing key ${artifact.signingKeyId} is not trusted.`,
        false,
      );
    }
    let valid = false;
    try {
      valid = verify(
        null,
        signaturePayload(artifact),
        createPublicKey(key),
        Buffer.from(artifact.signature, "base64"),
      );
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new ManagedRuntimeInstallError(
        "signature",
        "Managed runtime artifact signature is invalid.",
        false,
      );
    }
  }

  async #verifyInstalledRuntime(
    pointer: RuntimePointer,
    artifact: ManagedWebRuntimeArtifact,
  ): Promise<void> {
    const directory = this.#versionDirectory(pointer.archiveSha256);
    await this.#requireDirectory(directory);
    await this.#runInventory(directory, artifact);
    await this.#runProbe(directory, artifact);
  }

  async #runInventory(
    directory: string,
    artifact: ManagedWebRuntimeArtifact,
  ): Promise<void> {
    try {
      await this.#options.validateInventory({
        artifact,
        runtimeDirectory: directory,
      });
    } catch (error) {
      throw new ManagedRuntimeInstallError(
        "inventory",
        `Managed runtime inventory is invalid: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
    }
  }

  async #runProbe(
    directory: string,
    artifact: ManagedWebRuntimeArtifact,
  ): Promise<void> {
    try {
      await this.#options.probe({ artifact, runtimeDirectory: directory });
    } catch (error) {
      throw new ManagedRuntimeInstallError(
        "health-check",
        `Managed runtime health check failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }

  async #ensureStorage(): Promise<void> {
    await ensurePrivateDirectory(
      path.join(this.#options.dataDirectory, "managed-runtimes"),
    );
    await ensurePrivateDirectory(this.#root);
    await ensurePrivateDirectory(path.join(this.#root, "versions"));
    await ensurePrivateDirectory(path.join(this.#root, "downloads"));
    await ensurePrivateDirectory(path.join(this.#root, "staging"));
  }

  async #loadPointer(): Promise<RuntimePointer | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.#pointerPath(), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new ManagedRuntimeInstallError(
        "integrity",
        "Managed runtime current pointer is unreadable.",
        false,
      );
    }
    const pointer = parsePointer(parsed, this.#component);
    if (!pointer) {
      throw new ManagedRuntimeInstallError(
        "integrity",
        "Managed runtime current pointer is invalid.",
        false,
      );
    }
    await this.#requireDirectory(this.#versionDirectory(pointer.archiveSha256));
    return pointer;
  }

  async #requireDirectory(directory: string): Promise<void> {
    let entry;
    try {
      entry = await lstat(directory);
    } catch {
      throw new ManagedRuntimeInstallError(
        "inventory",
        "Managed runtime version directory is missing.",
        true,
      );
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new ManagedRuntimeInstallError(
        "inventory",
        "Managed runtime version path is not a real directory.",
        false,
      );
    }
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = path.join(this.#root, "install.lock");
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const lockStat = await lstat(lock).catch(() => null);
        if (
          lockStat?.isSymbolicLink() ||
          (lockStat && !lockStat.isDirectory())
        ) {
          throw new ManagedRuntimeInstallError(
            "disk",
            "Managed runtime installer lock is not a real directory.",
            false,
          );
        }
        if (lockStat && Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
          await rm(lock, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new ManagedRuntimeInstallError(
            "disk",
            "Timed out waiting for the managed runtime installer lock.",
            true,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    try {
      return await operation();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  async #cleanup(pointer: RuntimePointer): Promise<void> {
    this.#progress("cleanup", 0, 0);
    const retained = new Set([
      pointer.archiveSha256,
      ...(pointer.previous ? [pointer.previous.archiveSha256] : []),
    ]);
    for (const name of await readdir(path.join(this.#root, "versions"))) {
      if (/^[0-9a-f]{64}$/u.test(name) && !retained.has(name)) {
        await rm(path.join(this.#root, "versions", name), {
          recursive: true,
          force: true,
        });
      }
    }
    const now = this.#now().getTime();
    for (const directory of ["downloads", "staging"] as const) {
      const root = path.join(this.#root, directory);
      for (const name of await readdir(root)) {
        const candidate = path.join(root, name);
        const candidateStat = await stat(candidate).catch(() => null);
        if (candidateStat && now - candidateStat.mtimeMs > PARTIAL_STALE_MS) {
          await rm(candidate, { recursive: true, force: true });
        }
      }
    }
    this.#status = managedWebRuntimeStatusSchema.parse({
      ...this.#status,
      progress: null,
    });
  }

  #pointerPath(): string {
    return path.join(this.#root, "current.json");
  }

  #versionDirectory(sha256: string): string {
    return path.join(this.#root, "versions", sha256);
  }

  #applyPointer(
    pointer: RuntimePointer,
    state: ManagedWebRuntimeStatus["state"],
    failure: ManagedWebRuntimeFailure | null,
  ): void {
    this.#activeArchiveSha256 = pointer.archiveSha256;
    this.#status = managedWebRuntimeStatusSchema.parse({
      ...this.#status,
      supported: true,
      state,
      installedVersion: pointer.version,
      previousVersion: pointer.previous?.version ?? null,
      progress: null,
      failure,
    });
  }

  #progress(
    phase: NonNullable<ManagedWebRuntimeStatus["progress"]>["phase"],
    completedBytes: number,
    totalBytes: number,
  ): void {
    this.#status = managedWebRuntimeStatusSchema.parse({
      ...this.#status,
      progress: {
        phase,
        completedBytes,
        totalBytes,
        updatedAt: this.#now().toISOString(),
      },
    });
  }
}
