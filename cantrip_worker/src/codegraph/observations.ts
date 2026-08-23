import type { CodeGraphObservationTarget } from "@cantrip/protocol";

const MAX_TARGETS = 128;

function targetIdentity(target: CodeGraphObservationTarget): string {
  return `${target.projectId}\0${target.worktreeId}`;
}

export class CodeGraphObservationCoordinator {
  readonly #activate: (targets: CodeGraphObservationTarget[]) => Promise<void>;
  #targets: CodeGraphObservationTarget[] = [];
  #tail: Promise<void> = Promise.resolve();

  constructor(
    activate: (targets: CodeGraphObservationTarget[]) => Promise<void>,
  ) {
    this.#activate = activate;
  }

  configure(targets: CodeGraphObservationTarget[]): Promise<void> {
    this.#targets = [...targets];
    return this.#enqueue();
  }

  ensure(target: CodeGraphObservationTarget): Promise<void> {
    const identity = targetIdentity(target);
    const retained = this.#targets.filter(
      (candidate) => targetIdentity(candidate) !== identity,
    );
    this.#targets = [...retained.slice(-(MAX_TARGETS - 1)), target];
    return this.#enqueue();
  }

  forgetPath(worktreePath: string): void {
    this.#targets = this.#targets.filter(
      (target) => target.worktreePath !== worktreePath,
    );
  }

  refresh(): Promise<void> {
    return this.#enqueue();
  }

  #enqueue(): Promise<void> {
    const snapshot = [...this.#targets];
    const next = this.#tail
      .catch(() => undefined)
      .then(() => this.#activate(snapshot));
    this.#tail = next;
    return next;
  }
}
