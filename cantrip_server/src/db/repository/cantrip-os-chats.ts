import { and, eq } from "drizzle-orm";
import {
  cantripOsExecutionSchema,
  type CantripOsExecution,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import { CantripOsRepository, CantripOsPlacementError } from "./cantrip-os.js";
import { requireWorkerLocalPath } from "./worker-local-source-path.js";

type Source = NonNullable<
  Awaited<ReturnType<CantripOsRepository["bindingContext"]>>
>;
const fail = (message: string): never => {
  throw new CantripOsPlacementError(message);
};

/** A new chat captures its exact binding and generations before native preparation.
 * Existing conversations are never repurposed through this placement path. */
export class CantripOsChatRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async select(ownerId: string, projectId: string, bindingId: string) {
    const source = await new CantripOsRepository(this.database).bindingContext(
      ownerId,
      bindingId,
    );
    if (!source || !source.available || source.binding.projectId !== projectId)
      return fail("The selected OS project binding is unavailable.");
    const [worktree] = await this.database
      .select()
      .from(schema.projectWorktrees)
      .where(eq(schema.projectWorktrees.id, source.binding.worktreeId));
    if (!worktree) return fail("The OS worktree is unavailable.");
    return { source, worktree, workerId: source.instance.workerId };
  }

  async capture(chatId: string, source: Source) {
    if (!source.instance.runtimeGeneration)
      return fail("The OS has no current runtime generation.");
    await this.database.insert(schema.cantripOsChatPlacements).values({
      chatId,
      bindingId: source.binding.id,
      bindingGeneration: source.binding.bindingGeneration,
      attachmentGeneration: source.instance.attachmentGeneration,
      runtimeGeneration: source.instance.runtimeGeneration,
    });
  }

  async resolve(
    ownerId: string,
    chatId: string,
    worktree: {
      id: string;
      workerId: string;
      absolutePath: string | null;
      locationKind: "worker-local" | "cantrip-os";
    },
  ): Promise<{
    cwd: string;
    osExecution?: CantripOsExecution;
    computerUseEnabled?: false;
  }> {
    const [captured] = await this.database
      .select()
      .from(schema.cantripOsChatPlacements)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.cantripOsChatPlacements.chatId),
          eq(schema.chats.ownerId, ownerId),
        ),
      )
      .where(eq(schema.cantripOsChatPlacements.chatId, chatId));
    if (!captured) {
      if (worktree.locationKind === "cantrip-os")
        return fail(
          "This Linux source requires an explicit OS chat placement.",
        );
      return { cwd: requireWorkerLocalPath(worktree.absolutePath) };
    }
    const placement = captured.cantrip_os_chat_placements;
    const source = await new CantripOsRepository(
      this.database,
    ).executionContext(ownerId, placement.bindingId, placement);
    const { binding: b, workspace: w, instance: i } = source;
    if (
      b.worktreeId !== worktree.id ||
      i.workerId !== worktree.workerId ||
      b.projectId !== captured.chats.projectId
    )
      return fail(
        "The chat worktree differs from its captured OS binding; no host fallback was attempted.",
      );
    const osExecution = cantripOsExecutionForSource(ownerId, source, placement);
    return { cwd: b.guestPath, osExecution, computerUseEnabled: false };
  }
}

export function cantripOsExecutionForSource(
  ownerId: string,
  source: Source,
  placement: {
    bindingGeneration: string;
    attachmentGeneration: string;
    runtimeGeneration: string;
  },
): CantripOsExecution {
  const { binding: b, workspace: w, instance: i } = source;
  return cantripOsExecutionSchema.parse({
    kind: "cantrip-os",
    transport: source.transport,
    scope: {
      ownerId,
      workerId: i.workerId,
      instanceId: i.id,
      guestInstanceId: i.guestInstanceId,
      attachmentGeneration: placement.attachmentGeneration,
      runtimeGeneration: placement.runtimeGeneration,
      bindingId: b.id,
      bindingGeneration: placement.bindingGeneration,
      projectId: b.projectId,
      projectSourceId: b.projectSourceId,
      sourceKind: source.sourceKind,
      worktreeId: b.worktreeId,
      workspaceId: w.id,
      guestWorkspaceId: w.guestWorkspaceId,
      uid: w.uid,
      gid: w.gid,
      homeGuestPath: w.homeGuestPath,
      guestPath: b.guestPath,
      mode: b.mode,
      linkedWorkerPath: b.linkedWorkerPath,
      dependencyOverlays: b.dependencyOverlays,
    },
  });
}
