import {
  CUA_EFFECT_OFF,
  cuaEffectPreferencesSchema,
  cuaEffectStatusSchema,
  type CuaEffectPreferences,
  type CuaEffectWorkerStatus,
} from "@cantrip/protocol/computer-use-effects";
import type { CuaTransport } from "./transport.js";

/** One account-owned configuration per helper, shared by every attached agent.
 * This controller never launches a helper or changes an input lifetime. */
export class CuaEffects {
  private preferences: CuaEffectPreferences = {
    revision: 0,
    configuration: CUA_EFFECT_OFF,
  };
  private native: CuaEffectWorkerStatus["native"] = null;
  private error: string | null = null;
  private applied: { transport: CuaTransport; revision: number } | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly transport: () => CuaTransport | null) {}

  status(): CuaEffectWorkerStatus {
    const running = this.transport();
    return {
      ...this.preferences,
      state: this.error && running ? "failed" : running ? "running" : "idle",
      error: running ? this.error : null,
      native:
        running && this.applied?.transport === running ? this.native : null,
    };
  }

  update(input: CuaEffectPreferences): Promise<CuaEffectWorkerStatus> {
    const next = cuaEffectPreferencesSchema.parse(input);
    if (next.revision > this.preferences.revision) this.preferences = next;
    return this.synchronize();
  }

  synchronize(): Promise<CuaEffectWorkerStatus> {
    // Serialize updates, but select the newest preference when the queued work
    // actually runs. Delayed heartbeats cannot restore an older effect.
    const work = this.queue.then(async () => {
      const transport = this.transport();
      if (!transport || !this.preferences.revision) return;
      try {
        do {
          const desired = this.preferences;
          const needsApply =
            this.applied?.transport !== transport ||
            this.applied.revision !== desired.revision;
          const result = await transport.request(
            needsApply
              ? {
                  operation: "effects.configure",
                  configuration: desired.configuration,
                }
              : { operation: "effects.get" },
          );
          if (transport !== this.transport()) return;
          if (result.payload.length)
            throw new Error("Unexpected effect status payload.");
          this.native = cuaEffectStatusSchema.parse(result.data);
          this.applied = { transport, revision: desired.revision };
          this.error = null;
        } while (this.applied.revision !== this.preferences.revision);
      } catch (error) {
        if (transport !== this.transport()) return;
        this.applied = null;
        this.native = null;
        this.error =
          error instanceof Error
            ? error.message
            : "Window effects could not be configured.";
      }
    });
    this.queue = work;
    return work.then(() => this.status());
  }
}
