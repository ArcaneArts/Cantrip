import path from "node:path";
import type { CantripOsExecution } from "@cantrip/protocol";

import { terminalPrivateStateProtectedContentSchema } from "@cantrip/protocol/surface-private-state";

import { decodeSurfacePrivateStateForWorker } from "./surface-private-state-encryption.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

export interface TerminalPrivateStateRuntime {
  cwd: string;
  serviceCommand: string;
  osExecution?: CantripOsExecution;
}

export async function openTerminalPrivateState(input: {
  serverId: string;
  terminalId: string;
  worktreePath: string | CantripOsExecution;
  stateProtection: unknown;
  service: WorkerEncryptionService;
}): Promise<TerminalPrivateStateRuntime> {
  const content = terminalPrivateStateProtectedContentSchema.parse(
    await decodeSurfacePrivateStateForWorker({
      ownerId: input.service.ownerId(),
      context: {
        serverId: input.serverId,
        resource: "terminal-row",
        resourceId: input.terminalId,
        operationId: null,
        recordKind: "terminal-state",
      },
      opaque: input.stateProtection,
      service: input.service,
    }),
  );
  const osExecution =
    typeof input.worktreePath === "string" ? undefined : input.worktreePath;
  const paths = osExecution ? path.posix : path;
  const root = osExecution
    ? osExecution.scope.guestPath
    : paths.resolve(input.worktreePath as string);
  if (content.directory.kind === "project-root") {
    return {
      cwd: root,
      serviceCommand: content.serviceCommand,
      ...(osExecution ? { osExecution } : {}),
    };
  }
  const cwd = paths.resolve(root, content.directory.path);
  const relative = paths.relative(root, cwd);
  if (
    relative === ".." ||
    relative.startsWith(`..${paths.sep}`) ||
    paths.isAbsolute(relative)
  ) {
    throw new Error("The protected terminal directory escapes its worktree.");
  }
  return {
    cwd,
    serviceCommand: content.serviceCommand,
    ...(osExecution ? { osExecution } : {}),
  };
}
