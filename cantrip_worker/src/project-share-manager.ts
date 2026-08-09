import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import type { Server } from "node:http";

import type { WorkerProjectShareOpenResult } from "@cantrip/protocol";
import { v2 as webdav } from "webdav-server";

const LOOPBACK_HOST = "127.0.0.1" as const;
const SHARE_REALM = "Cantrip Project Share";
const DEFAULT_MAX_SHARES = 8;

interface ManagedProjectShare {
  descriptor: WorkerProjectShareOpenResult;
  listener: Server;
  root: string;
  server: webdav.WebDAVServer;
}

export interface ProjectShareOpenInput {
  root: string;
  shareId: string;
}

export interface ProjectShareManagerOptions {
  maxShares?: number;
}

export class ProjectShareManager {
  readonly #maxShares: number;
  readonly #opening = new Map<string, Promise<WorkerProjectShareOpenResult>>();
  readonly #shares = new Map<string, ManagedProjectShare>();

  constructor(options: ProjectShareManagerOptions = {}) {
    this.#maxShares = options.maxShares ?? DEFAULT_MAX_SHARES;
    if (!Number.isInteger(this.#maxShares) || this.#maxShares < 1) {
      throw new Error("Project share limit must be a positive integer.");
    }
  }

  get(shareId: string): WorkerProjectShareOpenResult | null {
    return this.#shares.get(shareId)?.descriptor ?? null;
  }

  async open(
    input: ProjectShareOpenInput,
  ): Promise<WorkerProjectShareOpenResult> {
    const root = await realpath(input.root);
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) {
      throw new Error("Project share root must be a directory.");
    }

    const existing = this.#shares.get(input.shareId);
    if (existing) {
      if (existing.root !== root) {
        throw new Error(
          "Project share identity is already bound to another root.",
        );
      }
      return existing.descriptor;
    }

    const opening = this.#opening.get(input.shareId);
    if (opening) {
      await opening;
      return this.open(input);
    }

    if (this.#shares.size + this.#opening.size >= this.#maxShares) {
      throw new Error(
        `Worker project share limit of ${this.#maxShares} sessions reached.`,
      );
    }

    const pending = this.#start({ ...input, root });
    this.#opening.set(input.shareId, pending);
    try {
      return await pending;
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
  ): Promise<WorkerProjectShareOpenResult> {
    const username = `cantrip-${randomBytes(12).toString("hex")}`;
    const password = randomBytes(32).toString("base64url");
    const userManager = new webdav.SimpleUserManager();
    const user = userManager.addUser(username, password, false);
    const privilegeManager = new webdav.SimplePathPrivilegeManager();
    privilegeManager.setRights(user, "/", ["all"]);

    const server = new webdav.WebDAVServer({
      hostname: LOOPBACK_HOST,
      httpAuthentication: new webdav.HTTPDigestAuthentication(
        userManager,
        SHARE_REALM,
      ),
      port: 0,
      privilegeManager,
      requireAuthentification: true,
      rootFileSystem: new webdav.PhysicalFileSystem(input.root),
      serverName: "Cantrip",
    });
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

    const descriptor: WorkerProjectShareOpenResult = Object.freeze({
      loopbackHost: LOOPBACK_HOST,
      loopbackPort: address.port,
      password,
      protocol: "webdav",
      realm: SHARE_REALM,
      shareId: input.shareId,
      username,
    });
    this.#shares.set(input.shareId, {
      descriptor,
      listener,
      root: input.root,
      server,
    });
    return descriptor;
  }
}
