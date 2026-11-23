import {
  cuaPreviewAuthoritySchema,
  cuaPreviewRevocationSchema,
  type CuaPreviewRevocation,
} from "@cantrip/protocol/computer-use-preview";

import { serverLogger } from "../../logger.js";

export const COMPUTER_USE_AUTHORITY_CHANNEL = "cantrip_computer_use_authority";
const authorityChangeSchema = cuaPreviewAuthoritySchema
  .pick({ ownerId: true })
  .extend({
    scope: cuaPreviewRevocationSchema,
  })
  .strict();

export interface ComputerUseAuthorityChange {
  ownerId: string;
  scope: CuaPreviewRevocation;
}
export type ComputerUseAuthorityListener = (
  change: ComputerUseAuthorityChange,
) => void | Promise<void>;

/** Best-effort post-commit interruption, not the durable authorization fence.
 * PostgreSQL coalesces identical channel/payload notifications per transaction.
 * A missed notification is fenced by the chat generation on the next operation.
 */
export class ComputerUseAuthorityChanges {
  private readonly listeners = new Set<ComputerUseAuthorityListener>();
  private readonly delivering = new Map<
    string,
    { change: ComputerUseAuthorityChange; dirty: boolean }
  >();

  subscribe(listener: ComputerUseAuthorityListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  receive(payload: string): void {
    // NOTIFY is not a public route, but other database writers still must not
    // inject unbounded or foreign fields into a worker cancellation command.
    let change: ComputerUseAuthorityChange;
    try {
      if (payload.length > 4096) throw new Error("oversized notification");
      const parsed = authorityChangeSchema.parse(JSON.parse(payload));
      change = Object.freeze({
        ownerId: parsed.ownerId,
        scope: Object.freeze(parsed.scope),
      });
    } catch {
      this.diagnose("invalid-notification");
      return;
    }
    if (this.listeners.size === 0) return;
    const key = JSON.stringify(change);
    const current = this.delivering.get(key);
    if (current) {
      current.dirty = true;
      return;
    }
    if (this.delivering.size >= 256) {
      this.diagnose("notification-capacity");
      return;
    }
    const entry = { change, dirty: false };
    this.delivering.set(key, entry);
    void this.deliver(key, entry);
  }

  private async deliver(
    key: string,
    entry: { change: ComputerUseAuthorityChange; dirty: boolean },
  ): Promise<void> {
    do {
      entry.dirty = false;
      // Never await these worker callbacks in an ordinary database mutation.
      await Promise.all(
        [...this.listeners].map(async (listener) => {
          try {
            await listener(entry.change);
          } catch {
            this.diagnose("observer-failed");
          }
        }),
      );
    } while (entry.dirty && this.listeners.size > 0);
    this.delivering.delete(key);
  }

  private diagnose(reasonCode: string): void {
    serverLogger.rateLimited(
      `computer-use-authority:${reasonCode}`,
      "warn",
      "Computer-use authority notification could not be delivered",
      {
        event: "computer-use.authority.notification-failed",
        subsystem: "computer-use",
        operation: "revoke-preview",
        status: "degraded",
        reasonCode,
      },
      { summaryEvery: 5, windowMs: 60_000 },
    );
  }
}
