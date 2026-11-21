import { createHash } from "node:crypto";
import { posix } from "node:path";
import { cantripOsGuestPathSchema } from "@cantrip/protocol";
import type { OsExecutorConnection } from "./connection.js";
import { guestFileUri, guestPathFromFileUri } from "./paths.js";
import {
  runGuestProcess,
  OsProcessOutcomeUnknownError,
  type GuestProcessResult,
} from "./process.js";

interface SourceScope {
  sourceId: string;
  operationId: string;
  guestPath: string;
}
export interface LinuxSourcePlan extends SourceScope {
  sourceKind: "git" | "folder";
  repositoryUrl: string | null;
  revision: string | null;
}
export interface LinuxSourceReceipt {
  sourceId: string;
  guestPath: string;
  sourceKind: "git" | "folder";
  head: string | null;
  branch: string | null;
  detached: boolean;
  gitCommonGuestPath: string | null;
  repositoryFingerprint: string | null;
}
export interface SourceCommandOptions {
  signal?: AbortSignal;
  /** Records each finite native process in the owning server operation. */
  prepared?: (processId: string, argv: string[]) => Promise<void>;
}

export interface SourceMutationOptions extends SourceCommandOptions {
  prepared: (processId: string, argv: string[]) => Promise<void>;
}

export class LinuxSourceCommandError extends Error {
  constructor(readonly result: GuestProcessResult) {
    super(
      `Linux source command exited ${result.exitCode ?? "without an exit code"}.`,
    );
  }
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const revision = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
async function command(
  connection: OsExecutorConnection,
  argv: string[],
  cwd: string,
  options: SourceCommandOptions,
) {
  const result = await runGuestProcess(connection, argv, cwd, {
    signal: options.signal,
    env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    prepared: (id) => options.prepared?.(id, argv) ?? Promise.resolve(),
  });
  if (result.outputTruncated)
    throw new OsProcessOutcomeUnknownError(
      result.processId,
      new Error(
        "Linux source command output is incomplete; its mutation was not repeated.",
      ),
    );
  if (result.exitCode !== 0 || result.failure || result.terminationRequested)
    throw new LinuxSourceCommandError(result);
  // Git paths may end in significant spaces or even a newline. Remove only
  // the command's final Linux line delimiter, never filesystem-name bytes.
  return result.stdout.replace(/\n$/u, "");
}

async function gitIdentity(
  connection: OsExecutorConnection,
  sourceId: string,
  guestPath: string,
  options: SourceCommandOptions,
): Promise<LinuxSourceReceipt> {
  const head = await command(
    connection,
    ["git", "-C", guestPath, "rev-parse", "--verify", "HEAD^{commit}"],
    guestPath,
    options,
  );
  const branch = await command(
    connection,
    ["git", "-C", guestPath, "branch", "--show-current"],
    guestPath,
    options,
  );
  const common = await command(
    connection,
    [
      "git",
      "-C",
      guestPath,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ],
    guestPath,
    options,
  );
  cantripOsGuestPathSchema.parse(common);
  return {
    sourceId,
    guestPath,
    sourceKind: "git",
    head,
    branch: branch || null,
    detached: !branch,
    gitCommonGuestPath: common,
    repositoryFingerprint: createHash("sha256")
      .update(
        JSON.stringify({
          instance: connection.binding.instance_id,
          workspace: connection.binding.workspace_id,
          common,
        }),
      )
      .digest("hex"),
  };
}

/** Observe an explicitly selected existing Linux repository/folder without
 * cloning, moving it, or changing its Git state. Managed clones use the
 * separate provisioning operation below. */
export async function inspectLinuxSource(
  connection: OsExecutorConnection,
  source: {
    sourceId: string;
    guestPath: string;
    sourceKind: "git" | "folder";
    requireRepositoryRoot?: boolean;
  },
  options: SourceCommandOptions = {},
): Promise<LinuxSourceReceipt> {
  if (!uuid.test(source.sourceId))
    throw new Error("A canonical source ID is required.");
  const actual = await connection.request<{ path: string }>("fs/canonicalize", {
    path: guestFileUri(source.guestPath),
    sandbox: null,
  });
  const guestPath = guestPathFromFileUri(actual.path);
  const metadata = await connection.request<{ isDirectory: boolean }>(
    "fs/getMetadata",
    {
      path: actual.path,
      followSymlinks: true,
      sandbox: null,
    },
  );
  if (!metadata.isDirectory)
    throw new Error("The selected Linux source is not a directory.");
  if (source.sourceKind === "git" && source.requireRepositoryRoot) {
    const root = await command(
      connection,
      ["git", "-C", guestPath, "rev-parse", "--show-toplevel"],
      guestPath,
      options,
    );
    if (root !== guestPath)
      throw new Error(
        "Select the Git worktree root when registering an existing repository.",
      );
  }
  return source.sourceKind === "git"
    ? gitIdentity(connection, source.sourceId, guestPath, options)
    : {
        sourceId: source.sourceId,
        guestPath,
        sourceKind: "folder",
        head: null,
        branch: null,
        detached: false,
        gitCommonGuestPath: null,
        repositoryFingerprint: null,
      };
}

/** Provisions once into an operation-specific staging directory. Existing
 * staging/target data is retained on failure; callers reconcile actual native
 * sessions and filesystem state instead of cloning again after delivery loss. */
export async function provisionLinuxSource(
  connection: OsExecutorConnection,
  plan: LinuxSourcePlan,
  options: SourceMutationOptions,
): Promise<LinuxSourceReceipt> {
  if (!uuid.test(plan.sourceId) || !uuid.test(plan.operationId))
    throw new Error("Canonical source and operation IDs are required.");
  const target = cantripOsGuestPathSchema.parse(plan.guestPath);
  if (
    target !== posix.join(connection.binding.home, "checkouts", plan.sourceId)
  )
    throw new Error(
      "Managed source location does not match the selected workspace.",
    );
  if (
    plan.sourceKind === "git" &&
    (!plan.repositoryUrl || !plan.revision || !revision.test(plan.revision))
  )
    throw new Error(
      "Git provisioning requires a repository and an exact commit revision.",
    );
  if (
    plan.sourceKind === "folder" &&
    (plan.repositoryUrl !== null || plan.revision !== null)
  )
    throw new Error("A folder source cannot carry a Git provisioning request.");
  const reservation = posix.join(
    connection.binding.home,
    ".local",
    "state",
    "cantrip-os-source-operations",
    plan.operationId,
  );
  const staging = posix.join(reservation, "checkout");
  await connection.request("fs/createDirectory", {
    path: guestFileUri(posix.dirname(target)),
    recursive: true,
    sandbox: null,
  });
  await connection.request("fs/createDirectory", {
    path: guestFileUri(posix.dirname(reservation)),
    recursive: true,
    sandbox: null,
  });
  // This reservation survives publication. Re-dispatching an already admitted
  // operation fails here, before another clone or file mutation can start.
  await connection.request("fs/createDirectory", {
    path: guestFileUri(reservation),
    recursive: false,
    sandbox: null,
  });
  await connection.request("fs/writeFile", {
    path: guestFileUri(posix.join(reservation, "intent.json")),
    dataBase64: Buffer.from(JSON.stringify(plan)).toString("base64"),
    sandbox: null,
  });
  await connection.request("fs/createDirectory", {
    path: guestFileUri(staging),
    recursive: false,
    sandbox: null,
  });
  if (plan.sourceKind === "git") {
    await command(
      connection,
      [
        "git",
        "clone",
        "--no-checkout",
        "--no-local",
        "--",
        plan.repositoryUrl!,
        staging,
      ],
      connection.binding.home,
      options,
    );
    await command(
      connection,
      ["git", "-C", staging, "checkout", "--detach", plan.revision!],
      staging,
      options,
    );
    const head = await command(
      connection,
      ["git", "-C", staging, "rev-parse", "--verify", "HEAD^{commit}"],
      staging,
      options,
    );
    if (head.toLowerCase() !== plan.revision!.toLowerCase())
      throw new Error(
        "Provisioned Git revision did not match the admitted commit.",
      );
  }
  // The native protocol has no rename RPC. Linux renameat2 supplies the required
  // atomic, no-replacement publication; it never merges with an existing root.
  await command(
    connection,
    [
      "python3",
      "-c",
      `
import ctypes,os,sys
libc=ctypes.CDLL(None,use_errno=True)
if libc.renameat2(-100,os.fsencode(sys.argv[1]),-100,os.fsencode(sys.argv[2]),1):
    code=ctypes.get_errno()
    raise OSError(code,os.strerror(code))
`,
      staging,
      target,
    ],
    connection.binding.home,
    options,
  );
  const receipt: LinuxSourceReceipt =
    plan.sourceKind === "git"
      ? await gitIdentity(connection, plan.sourceId, target, options)
      : {
          sourceId: plan.sourceId,
          guestPath: target,
          sourceKind: "folder",
          head: null,
          branch: null,
          detached: false,
          gitCommonGuestPath: null,
          repositoryFingerprint: null,
        };
  await connection.request("fs/writeFile", {
    path: guestFileUri(posix.join(reservation, "result.json")),
    dataBase64: Buffer.from(JSON.stringify(receipt)).toString("base64"),
    sandbox: null,
  });
  return receipt;
}

/** Worktree identity and branch leases are admitted by Server before this call.
 * Git metadata stays in the Linux-owned repository, not a host directory. */
export async function createLinuxWorktree(
  connection: OsExecutorConnection,
  plan: {
    sourceId: string;
    sourceGuestPath: string;
    worktreeId: string;
    guestPath: string;
    revision: string;
    branch: string | null;
    expectedRepositoryFingerprint?: string;
  },
  options: SourceMutationOptions,
) {
  if (
    !uuid.test(plan.sourceId) ||
    !uuid.test(plan.worktreeId) ||
    !revision.test(plan.revision)
  )
    throw new Error(
      "Canonical source/worktree IDs and an exact revision are required.",
    );
  const source = cantripOsGuestPathSchema.parse(plan.sourceGuestPath);
  const relative = posix.relative(connection.binding.home, source);
  if (
    relative === ".." ||
    relative.startsWith("../") ||
    posix.isAbsolute(relative)
  )
    throw new Error(
      "The Primary source is outside its selected Linux workspace.",
    );
  if (
    plan.guestPath !==
    posix.join(connection.binding.home, "worktrees", plan.worktreeId)
  )
    throw new Error("Worktree locations do not match the selected workspace.");
  if (plan.expectedRepositoryFingerprint) {
    const actual = await inspectLinuxSource(
      connection,
      {
        sourceId: plan.sourceId,
        guestPath: source,
        sourceKind: "git",
        requireRepositoryRoot: true,
      },
      options,
    );
    if (
      actual.guestPath !== source ||
      actual.repositoryFingerprint !== plan.expectedRepositoryFingerprint
    )
      throw new Error(
        "The Linux Git common directory changed; no worktree mutation was started.",
      );
  }
  await connection.request("fs/createDirectory", {
    path: guestFileUri(posix.dirname(plan.guestPath)),
    recursive: true,
    sandbox: null,
  });
  await command(
    connection,
    [
      "git",
      "-C",
      plan.sourceGuestPath,
      "worktree",
      "add",
      ...(plan.branch ? ["-b", plan.branch] : ["--detach"]),
      "--",
      plan.guestPath,
      plan.revision,
    ],
    connection.binding.home,
    options,
  );
  return gitIdentity(connection, plan.sourceId, plan.guestPath, options);
}
