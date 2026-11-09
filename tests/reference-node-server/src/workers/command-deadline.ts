import { performance } from "node:perf_hooks";

type Phase = "waiting" | "preparing" | "running";

/** Queue/suspension time has no execution cost. Preparation remains bounded too. */
export class WorkerCommandDeadline {
  private phase: Phase = "preparing";
  private sequence = -1;
  private enteredAt = performance.now();
  private preparationRemaining: number;
  private executionRemaining: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private generation = 0;

  constructor(
    private readonly durationMs: number | null,
    private readonly expired: () => void,
  ) {
    this.preparationRemaining = durationMs ?? 0;
    this.executionRemaining = durationMs ?? 0;
    this.arm();
  }

  observe(sequence: number, phase: Phase): void {
    if (this.closed || sequence <= this.sequence) return;
    this.sequence = sequence;
    this.generation++;
    const now = performance.now();
    const elapsed = Math.max(0, now - this.enteredAt);
    if (this.phase === "preparing") this.preparationRemaining -= elapsed;
    if (this.phase === "running") this.executionRemaining -= elapsed;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.phase = phase;
    this.enteredAt = now;
    this.arm();
  }

  close(): void {
    this.closed = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.durationMs === null || this.phase === "waiting" || this.closed)
      return;
    const remaining =
      this.phase === "running"
        ? this.executionRemaining
        : this.preparationRemaining;
    const generation = this.generation;
    this.timer = setTimeout(
      () => {
        if (this.closed || generation !== this.generation) return;
        this.closed = true;
        this.expired();
      },
      Math.max(0, remaining),
    );
  }
}
