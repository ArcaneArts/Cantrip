import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CantripOsSourceDispatchScope,
  CantripOsTransport,
} from "@cantrip/protocol";
import { executorCommand, OsExecutorConnection } from "./connection.js";
import type { CantripOsController } from "./controller.js";
import type { CodexNativeEnvironment } from "../codex/runtime-types.js";
import {
  workspaceSnapshot,
  workspaceSnapshotFromPorcelainRecords,
} from "../codex/workspace-snapshots.js";
import { runGuestProcess } from "./process.js";
import { guestFileUri } from "./paths.js";

/** One native runtime uses one captured Linux placement. Upstream's environment
 * provider handles shell, filesystem, search and patch tools through this carrier.
 * Provider credentials and the app-server process stay on the owning worker. */
export class OsNativeEnvironment implements CodexNativeEnvironment {
  readonly id: string;
  readonly scope: CantripOsSourceDispatchScope;
  constructor(
    scope: CantripOsSourceDispatchScope,
    private readonly transport: CantripOsTransport,
    private readonly controller: Pick<
      CantripOsController,
      "captureExecutionBinding"
    >,
  ) {
    this.scope = structuredClone(scope);
    for (const overlay of this.scope.dependencyOverlays) Object.freeze(overlay);
    Object.freeze(this.scope.dependencyOverlays);
    Object.freeze(this.scope);
    this.id = `cantrip-os-${createHash("sha256")
      .update(
        JSON.stringify([
          scope.serverId,
          scope.ownerId,
          scope.workerId,
          scope.instanceId,
          scope.guestInstanceId,
          scope.attachmentGeneration,
          scope.runtimeGeneration,
          scope.bindingId,
          scope.bindingGeneration,
          scope.projectSourceId,
          scope.worktreeId,
          scope.workspaceId,
          scope.uid,
          scope.guestPath,
        ]),
      )
      .digest("hex")
      .slice(0, 48)}`;
  }

  get selection() {
    return {
      environmentId: this.id,
      cwd: this.scope.guestPath,
      runtimeWorkspaceRoots: [this.scope.guestPath],
    };
  }

  get instructions() {
    return `Execution uses the CantripOS Linux workspace ${this.scope.guestWorkspaceId}, UID ${this.scope.uid}, at ${this.scope.guestPath}. The Cantrip worker remains the orchestrator; provider credentials stay on it. Shell, read/search, patch and write tools operate in this guest environment. Use sudo -n for OS administration when the current permission profile permits it. Shells do not require a desktop; deliberate GUI launches must use this workspace's desktop context. Host computer use is unavailable for this target. Cantrip MCP is served by the owning worker over authenticated loopback; its credentials stay on the worker. Use only the tools advertised for this captured placement. Host-only Run/worktree handlers and delegated task creation are unavailable until source-aware adapters are installed. Worker-local CodeGraph/other stdio MCP servers and the worker CLI are unavailable in this remote session; use native Linux tools and configured network MCP servers. ${this.scope.mode === "linked" ? "These files are linked from the original worker. Git metadata may live outside the mount; use Cantrip's worker-routed Git tools for Git mutations, and do not rewrite .git or initialize another repository." : this.scope.sourceKind === "git" ? "This is a Linux-owned Git source; its Git operations run in Linux." : "This is a non-Git folder; do not initialize Git unless explicitly requested."} After transport loss or an unknown operation outcome, observe known sessions and file state; do not blindly repeat a mutation.`;
  }

  private assertCwd(cwd: string) {
    if (cwd !== this.scope.guestPath)
      throw new Error(
        "The native cwd differs from its captured Linux placement.",
      );
  }

  async hasGitMetadata(cwd: string): Promise<boolean> {
    this.assertCwd(cwd);
    return this.scope.sourceKind === "git";
  }

  async snapshot(cwd: string) {
    this.assertCwd(cwd);
    // Linked Git inspection remains with its original worker, including metadata
    // stored outside the mounted checkout. This is an explicit ownership path.
    if (this.scope.mode === "linked")
      return workspaceSnapshot(this.scope.linkedWorkerPath);
    if (this.scope.sourceKind === "folder") return new Map();
    const binding = await this.controller.captureExecutionBinding(
      this.transport,
      this.scope,
    );
    const connection = new OsExecutorConnection(this.transport, binding);
    try {
      await connection.request("initialize", {
        clientName: "cantrip-native-source-observation",
        resumeSessionId: null,
      });
      connection.notify("initialized");
      const result = await runGuestProcess(
        connection,
        [
          "git",
          "-C",
          cwd,
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ],
        cwd,
        { maxOutputBytes: 32 * 1024 * 1024 },
      );
      if (result.exitCode !== 0)
        throw new Error("The Linux Git source could not be observed.");
      return await workspaceSnapshotFromPorcelainRecords(
        cwd,
        result.stdout.split("\0").filter(Boolean),
        async (filename) => {
          const metadata = await connection.request<{
            size: number;
            modifiedAtMs: number;
            isSymlink: boolean;
            isDirectory: boolean;
          }>("fs/getMetadata", {
            path: guestFileUri(filename),
            followSymlinks: false,
            sandbox: null,
          });
          return {
            size: metadata.size,
            mtimeMs: metadata.modifiedAtMs,
            mode: metadata.isSymlink
              ? 0o120000
              : metadata.isDirectory
                ? 0o040000
                : 0o100000,
          };
        },
        path.posix.join,
      );
    } finally {
      await connection.close();
    }
  }

  async prepare(codexHome: string): Promise<void> {
    const binding = await this.controller.captureExecutionBinding(
      this.transport,
      this.scope,
    );
    const command = executorCommand(this.transport, [
      "connect",
      binding.workspace_id,
      "--expect",
      JSON.stringify(binding),
    ]);
    const contents = [
      `default = ${JSON.stringify(this.id)}`,
      "include_local = false",
      "[[environments]]",
      `id = ${JSON.stringify(this.id)}`,
      `program = ${JSON.stringify(command.command)}`,
      `args = ${JSON.stringify(command.args)}`,
      "initialize_timeout_sec = 60",
      "",
    ].join("\n");
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    const file = path.join(codexHome, "environments.toml");
    try {
      await writeFile(file, contents, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await readFile(file, "utf8")) !== contents)
        throw new Error(
          "This native runtime already belongs to a different execution environment.",
        );
    }
  }
}
