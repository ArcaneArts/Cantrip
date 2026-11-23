import type { CodexAppServer } from "./app-server.js";

type RootOwner = {
  operationId: string;
  runnerGeneration: string;
  threadId: string;
  transport: string;
  revision: string | null;
  acknowledged: boolean;
};

/** One actual native root hold, shared by managed input runners and Task private
 * gates. It owns no model ticket and never binds/rearms an execution gate. */
export class ManagedRootProducerHold {
  private owner: RootOwner | null = null;
  private mutations: Promise<void> = Promise.resolve();

  constructor(
    private readonly runtime: Pick<
      CodexAppServer,
      "controlManagedRootProducer"
    >,
  ) {}

  get heldBy() {
    return this.owner?.operationId ?? null;
  }

  get confirmedBy() {
    return this.owner?.acknowledged ? this.owner.operationId : null;
  }

  /** A stronger explicit Stop/revocation owns native invalidation. Forgetting
   * this control capability must never rearm or release that invalidation. */
  discard(): void {
    this.owner = null;
  }

  private mutate(operation: () => Promise<void>): Promise<void> {
    const pending = this.mutations.then(operation);
    this.mutations = pending.catch(() => {});
    return pending;
  }

  hold(
    operationId: string,
    runnerGeneration: string,
    threadId: string,
    transport: string,
  ): Promise<void> {
    return this.mutate(async () => {
      const owner = this.owner;
      if (
        owner &&
        (owner.operationId !== operationId ||
          owner.runnerGeneration !== runnerGeneration ||
          owner.threadId !== threadId ||
          owner.transport !== transport)
      )
        throw new Error("Another provider transfer owns this native root.");
      const current = (this.owner ??= {
        operationId,
        runnerGeneration,
        threadId,
        transport,
        revision: null,
        acknowledged: false,
      });
      if (current.revision === null) {
        const observed = await this.runtime.controlManagedRootProducer(
          { threadId, runnerGeneration, action: "read" },
          transport,
        );
        if (this.owner !== current)
          throw new Error(
            "The native root control was revoked during capture.",
          );
        if (observed.heldBy && observed.heldBy !== operationId)
          throw new Error("Another provider transfer holds this native root.");
        current.revision = observed.revision;
      }
      const held = await this.runtime.controlManagedRootProducer(
        {
          threadId,
          runnerGeneration,
          action: "hold",
          operationId,
          expectedRevision: current.revision,
        },
        transport,
      );
      if (this.owner !== current || held.heldBy !== operationId)
        throw new Error(
          "The native root did not acknowledge its transfer hold.",
        );
      current.revision = held.revision;
      current.acknowledged = true;
    });
  }

  release(
    operationId: string,
    runnerGeneration: string,
    threadId: string,
    transport: string,
  ): Promise<void> {
    return this.mutate(async () => {
      const current = this.owner;
      if (!current || current.operationId !== operationId) return;
      if (
        current.runnerGeneration !== runnerGeneration ||
        current.threadId !== threadId ||
        current.transport !== transport
      )
        throw new Error("The native root control belongs to another lifetime.");
      const observed = await this.runtime.controlManagedRootProducer(
        { threadId, runnerGeneration, action: "read" },
        transport,
      );
      if (this.owner !== current)
        throw new Error("The native root control was revoked during release.");
      if (observed.heldBy && observed.heldBy !== operationId)
        throw new Error("Another provider transfer holds this native root.");
      // A response may have been lost. When no hold has arrived yet, retiring
      // its exact observed revision prevents that delayed hold taking effect.
      const released = await this.runtime.controlManagedRootProducer(
        {
          threadId,
          runnerGeneration,
          action: "release",
          operationId,
          expectedRevision: observed.heldBy
            ? observed.revision
            : (current.revision ?? observed.revision),
        },
        transport,
      );
      if (this.owner !== current || released.heldBy !== null)
        throw new Error("The native root still holds a provider transfer.");
      this.owner = null;
    });
  }
}
