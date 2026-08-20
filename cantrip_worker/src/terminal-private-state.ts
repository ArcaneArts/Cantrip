import path from "node:path";

import { terminalPrivateStateProtectedContentSchema } from "@cantrip/protocol/surface-private-state";

import { decodeSurfacePrivateStateForWorker } from "./surface-private-state-encryption.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

export interface TerminalPrivateStateRuntime {
  cwd: string;
  serviceCommand: string;
}

export async function openTerminalPrivateState(input: {
  serverId: string;
  terminalId: string;
  worktreePath: string;
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
  const root = path.resolve(input.worktreePath);
  if (content.directory.kind === "project-root") {
    return { cwd: root, serviceCommand: content.serviceCommand };
  }
  const cwd = path.resolve(root, content.directory.path);
  const relative = path.relative(root, cwd);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("The protected terminal directory escapes its worktree.");
  }
  return { cwd, serviceCommand: content.serviceCommand };
}
