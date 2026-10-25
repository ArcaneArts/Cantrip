export interface QuitParticipant {
  suspend(): () => void;
  checkpoint(): Promise<void>;
}

/** A quit prepares actual writes, never infers durability from a dirty flag. */
export class DesktopQuitCoordinator {
  private participants = new Set<QuitParticipant>();
  private round: {
    id: number;
    releases: (() => void)[];
    changed: boolean;
    invalidate(): void;
  } | null = null;
  get preparing() {
    return this.round !== null;
  }
  register(participant: QuitParticipant): () => void {
    this.participants.add(participant);
    if (this.round) {
      this.round.changed = true;
      this.round.invalidate();
    }
    return () => {
      if (this.participants.delete(participant) && this.round) {
        this.round.changed = true;
        this.round.invalidate();
      }
    };
  }
  async prepare(id: number, invalidate = () => {}): Promise<void> {
    if (this.round) throw new Error("Another shutdown is still preparing.");
    const round = {
      id,
      releases: [] as (() => void)[],
      changed: false,
      invalidate,
    };
    this.round = round;
    const participants = [...this.participants];
    try {
      // Freeze every editor, including inactive ones, before awaiting any I/O.
      for (const participant of participants)
        round.releases.push(participant.suspend());
      await Promise.all(
        participants.map((participant) => participant.checkpoint()),
      );
      if (this.round !== round || round.changed)
        throw new Error("Editor ownership changed during shutdown.");
    } catch (error) {
      this.cancel(id);
      throw error;
    }
  }
  cancel(id: number): void {
    if (this.round?.id !== id) return;
    const { releases } = this.round;
    this.round = null;
    // A broken participant must not strand the other editors in read-only mode.
    for (const release of releases.reverse()) {
      try {
        release();
      } catch {
        console.error("An editor could not resume after cancelled shutdown.");
      }
    }
  }
}

export const desktopQuitCoordinator = new DesktopQuitCoordinator();
