import type { AppLiveResource } from "@cantrip/protocol";

import type { ChatLiveRouting } from "../db/repository.js";

export type TaskWorkloadLiveResource = Extract<
  AppLiveResource,
  "agent-interaction" | "chat-goal" | "chat-message" | "chat-plan" | "task"
>;

const taskWorkloadLiveResources = new Set<AppLiveResource>([
  "agent-interaction",
  "chat-goal",
  "chat-message",
  "chat-plan",
  "task",
]);

export function isTaskWorkloadLiveResource(
  resource: AppLiveResource,
): resource is TaskWorkloadLiveResource {
  return taskWorkloadLiveResources.has(resource);
}

interface TaskWorkloadInvalidation {
  chatId: string;
  entityId: string | null;
  ownerId: string;
  resource: TaskWorkloadLiveResource;
  routing?: ChatLiveRouting;
}

type ChatLiveRoutingLoader = (
  ownerId: string,
  chatId: string,
) => Promise<ChatLiveRouting | null>;

type TaskWorkloadPublisher = (input: {
  entityId: string;
  ownerId: string;
  projectId: string;
  resource: TaskWorkloadLiveResource;
}) => void | Promise<void>;

/**
 * Resolves only the routing fields required for project-scoped Task workload
 * invalidations. Concurrent ID-only invalidations share one lookup, but the
 * result is discarded as soon as that lookup settles.
 */
export class TaskLiveInvalidationRouter {
  readonly #inFlight = new Map<string, Promise<ChatLiveRouting | null>>();
  readonly #load: ChatLiveRoutingLoader;
  readonly #publish: TaskWorkloadPublisher;

  constructor(load: ChatLiveRoutingLoader, publish: TaskWorkloadPublisher) {
    this.#load = load;
    this.#publish = publish;
  }

  async route(input: TaskWorkloadInvalidation): Promise<void> {
    // Keep project fanout asynchronous even when the caller already knows the
    // routing metadata. The preceding chat-scoped event must remain observable
    // before its project-scoped workload invalidation.
    const routing = await (input.routing
      ? Promise.resolve(input.routing)
      : this.#resolve(input.ownerId, input.chatId));
    if (routing?.experience !== "task" || !routing.projectId) return;
    await this.#publish({
      entityId: input.entityId ?? input.chatId,
      ownerId: input.ownerId,
      projectId: routing.projectId,
      resource: input.resource,
    });
  }

  #resolve(ownerId: string, chatId: string): Promise<ChatLiveRouting | null> {
    const key = `${ownerId}\0${chatId}`;
    const active = this.#inFlight.get(key);
    if (active) return active;

    const lookup = this.#load(ownerId, chatId).finally(() => {
      if (this.#inFlight.get(key) === lookup) this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, lookup);
    return lookup;
  }
}
