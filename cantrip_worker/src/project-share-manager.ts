import { realpath, stat } from "node:fs/promises";
import type { Server } from "node:http";

import {
  PROJECT_SOURCE_UNAVAILABLE_CODE,
  projectSharePublicBasePathSchema,
  projectSharePublicOriginSchema,
  type WorkerProjectShareDescriptor,
} from "@cantrip/protocol";
import { v2 as webdav } from "webdav-server";

import { workerLogError, workerLogger } from "./logger.js";

const LOOPBACK_HOST = "127.0.0.1" as const;
const DEFAULT_MAX_SHARES = 8;
const FILE_MANAGER_METADATA_NAMES = new Set([
  ".appledouble",
  ".documentrevisions-v100",
  ".fseventsd",
  ".lsoverride",
  ".spotlight-v100",
  ".temporaryitems",
  ".trashes",
  "desktop.ini",
  "ehthumbs.db",
  "icon\r",
  "thumbs.db",
]);
const MUTATING_METHODS = new Set([
  "COPY",
  "DELETE",
  "LOCK",
  "MKCOL",
  "MOVE",
  "PROPPATCH",
  "PUT",
  "UNLOCK",
]);

interface ManagedProjectShare {
  descriptor: WorkerProjectShareDescriptor;
  listener: Server;
  root: string;
  server: webdav.WebDAVServer;
  startedAtMs: number;
}

export interface ProjectShareOpenInput {
  password: string;
  publicBasePath: string;
  publicOrigin: string;
  realm: string;
  root: string;
  shareId: string;
  username: string;
}

export interface ProjectShareManagerOptions {
  maxShares?: number;
}

export class ProjectSourceUnavailableError extends Error {
  readonly code = PROJECT_SOURCE_UNAVAILABLE_CODE;

  constructor(cause: unknown) {
    super("Project source is unavailable.", { cause });
    this.name = "ProjectSourceUnavailableError";
  }
}

function isUnavailableSourcePathError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function isFileManagerMetadataSegment(segment: string): boolean {
  const normalized = segment.toLowerCase();
  return (
    normalized === ".ds_store" ||
    normalized.startsWith(".ds_store.") ||
    normalized.startsWith("._") ||
    FILE_MANAGER_METADATA_NAMES.has(normalized)
  );
}

function destinationSegments(destination: string | null): string[] {
  if (!destination) return [];
  try {
    return new URL(destination, "http://cantrip.invalid").pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return [];
  }
}

function requestTargetsFileManagerMetadata(
  context: webdav.HTTPRequestContext,
): boolean {
  return [
    ...context.requested.path.paths,
    ...destinationSegments(context.headers.find("destination")),
  ].some(isFileManagerMetadataSegment);
}

function rejectFileManagerMetadataRequests(server: webdav.WebDAVServer): void {
  server.beforeRequest((context, next) => {
    if (!requestTargetsFileManagerMetadata(context)) {
      next();
      return;
    }

    const method = context.request.method?.toUpperCase() ?? "";
    context.setCode(MUTATING_METHODS.has(method) ? 403 : 404);
    context.response.setHeader("Cache-Control", "no-store");
    context.request.resume();
    context.exit();
  });
}

export class ProjectShareManager {
  readonly #maxShares: number;
  readonly #opening = new Map<string, Promise<WorkerProjectShareDescriptor>>();
  readonly #shares = new Map<string, ManagedProjectShare>();

  constructor(options: ProjectShareManagerOptions = {}) {
    this.#maxShares = options.maxShares ?? DEFAULT_MAX_SHARES;
    if (!Number.isInteger(this.#maxShares) || this.#maxShares < 1) {
      throw new Error("Project share limit must be a positive integer.");
    }
  }

  get(shareId: string): WorkerProjectShareDescriptor | null {
    return this.#shares.get(shareId)?.descriptor ?? null;
  }

  async open(
    input: ProjectShareOpenInput,
  ): Promise<WorkerProjectShareDescriptor> {
    const startedAtMs = Date.now();
    const publicBasePath = projectSharePublicBasePathSchema.parse(
      input.publicBasePath,
    );
    const publicOrigin = projectSharePublicOriginSchema.parse(
      input.publicOrigin,
    );
    let root: string;
    let rootStat: Awaited<ReturnType<typeof stat>>;
    try {
      root = await realpath(input.root);
      rootStat = await stat(root);
    } catch (error) {
      if (isUnavailableSourcePathError(error)) {
        throw new ProjectSourceUnavailableError(error);
      }
      throw error;
    }
    if (!rootStat.isDirectory()) {
      throw new Error("Project share root must be a directory.");
    }

    const existing = this.#shares.get(input.shareId);
    if (existing) {
      if (
        existing.root !== root ||
        existing.descriptor.publicBasePath !== publicBasePath ||
        existing.descriptor.publicOrigin !== publicOrigin ||
        existing.descriptor.username !== input.username ||
        existing.descriptor.password !== input.password ||
        existing.descriptor.realm !== input.realm
      ) {
        throw new Error(
          "Project share identity is already bound to another root or public endpoint.",
        );
      }
      workerLogger.event("debug", "Project share reused", {
        event: "project-share.reused",
        subsystem: "project-share",
        operation: "open",
        status: "completed",
        surfaceId: input.shareId,
      });
      return existing.descriptor;
    }

    const opening = this.#opening.get(input.shareId);
    if (opening) {
      await opening;
      return this.open(input);
    }

    if (this.#shares.size + this.#opening.size >= this.#maxShares) {
      workerLogger.event("warn", "Project share limit reached", {
        event: "project-share.rejected",
        subsystem: "project-share",
        operation: "open",
        reasonCode: "session-limit",
        status: "rejected",
        surfaceId: input.shareId,
        counts: {
          active: this.#shares.size,
          opening: this.#opening.size,
          limit: this.#maxShares,
        },
      });
      throw new Error(
        `Worker project share limit of ${this.#maxShares} sessions reached.`,
      );
    }

    const pending = this.#start({
      ...input,
      publicBasePath,
      publicOrigin,
      root,
    });
    this.#opening.set(input.shareId, pending);
    try {
      const descriptor = await pending;
      workerLogger.event("info", "Project share opened", {
        event: "project-share.opened",
        subsystem: "project-share",
        operation: "open",
        status: "completed",
        surfaceId: input.shareId,
        durationMs: Date.now() - startedAtMs,
        counts: { active: this.#shares.size },
      });
      return descriptor;
    } catch (error) {
      workerLogger.event("error", "Project share failed to open", {
        event: "project-share.open-failed",
        subsystem: "project-share",
        operation: "open",
        reasonCode: "open-failed",
        status: "failed",
        surfaceId: input.shareId,
        durationMs: Date.now() - startedAtMs,
        error: workerLogError(error),
      });
      throw error;
    } finally {
      this.#opening.delete(input.shareId);
    }
  }

  async close(shareId: string): Promise<boolean> {
    const opening = this.#opening.get(shareId);
    if (opening) {
      await opening;
    }

    const share = this.#shares.get(shareId);
    if (!share) return false;
    this.#shares.delete(shareId);

    const stopped = share.server.stopAsync();
    share.listener.closeAllConnections?.();
    await stopped;
    workerLogger.event("info", "Project share closed", {
      event: "project-share.closed",
      subsystem: "project-share",
      operation: "close",
      status: "completed",
      surfaceId: shareId,
      durationMs: Math.max(0, Date.now() - share.startedAtMs),
      counts: { active: this.#shares.size },
    });
    return true;
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(this.#opening.values());
    await Promise.all(
      [...this.#shares.keys()].map((shareId) => this.close(shareId)),
    );
  }

  async #start(
    input: ProjectShareOpenInput,
  ): Promise<WorkerProjectShareDescriptor> {
    const userManager = new webdav.SimpleUserManager();
    const user = userManager.addUser(input.username, input.password, false);
    const privilegeManager = new webdav.SimplePathPrivilegeManager();
    privilegeManager.setRights(user, input.publicBasePath, ["all"]);

    const server = new webdav.WebDAVServer({
      hostname: LOOPBACK_HOST,
      httpAuthentication: new webdav.HTTPDigestAuthentication(
        userManager,
        input.realm,
      ),
      port: 0,
      privilegeManager,
      requireAuthentification: true,
      serverName: "Cantrip",
    });
    rejectFileManagerMetadataRequests(server);
    if (
      !server.setFileSystemSync(
        input.publicBasePath,
        new webdav.PhysicalFileSystem(input.root),
      )
    ) {
      throw new Error("Could not mount the project at its public share path.");
    }
    const listener = await server.startAsync(0);
    const address = listener.address();
    if (
      !address ||
      typeof address === "string" ||
      address.address !== LOOPBACK_HOST
    ) {
      const stopped = server.stopAsync();
      listener.closeAllConnections?.();
      await stopped;
      throw new Error(
        "Could not establish the project share loopback endpoint.",
      );
    }

    const descriptor: WorkerProjectShareDescriptor = Object.freeze({
      loopbackHost: LOOPBACK_HOST,
      loopbackPort: address.port,
      password: input.password,
      protocol: "webdav",
      publicBasePath: input.publicBasePath,
      publicOrigin: input.publicOrigin,
      realm: input.realm,
      shareId: input.shareId,
      username: input.username,
    });
    this.#shares.set(input.shareId, {
      descriptor,
      listener,
      root: input.root,
      server,
      startedAtMs: Date.now(),
    });
    return descriptor;
  }
}
