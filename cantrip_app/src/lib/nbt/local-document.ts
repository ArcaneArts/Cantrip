import type { NbtDocumentClient } from "@cantrip/nbt/document";
import {
  NbtLocalReferenceSession,
  type NbtLocalReference,
} from "./local-reference";
import { nbtSharedDocument } from "./shared-document";

interface Source {
  origin: NbtLocalReference | null;
  file?: File;
}
export interface NbtLocalDocumentSnapshot extends Source {
  preparing: boolean;
  blocked: boolean;
  error: string | null;
}
interface Candidate extends Source {
  origin: NbtLocalReference;
  file: File;
  controller: AbortController;
  resolve(): void;
  reject(error: unknown): void;
  work?: Promise<void>;
  client?: NbtDocumentClient;
}
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The local NBT source could not be recovered.";

/** Owns the selected source for one stable view. A candidate is browsable while
 * indexing, but becomes editable only after its bytes and reference commit. */
export class NbtLocalDocument {
  private current: Source;
  private candidate?: Candidate;
  private closed = false;
  private clearing = false;
  private listeners = new Set<() => void>();
  private snapshot: NbtLocalDocumentSnapshot;
  private constructor(
    private pointer: NbtLocalReferenceSession,
    private openPointer: () => Promise<NbtLocalReferenceSession>,
  ) {
    this.current = { origin: pointer.value };
    this.snapshot = {
      ...this.current,
      preparing: false,
      blocked: false,
      error: null,
    };
  }
  static async open(openPointer: () => Promise<NbtLocalReferenceSession>) {
    return new NbtLocalDocument(await openPointer(), openPointer);
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private check() {
    if (this.closed) throw new Error("The local NBT view is closed.");
  }
  private publish(
    source: Source,
    preparing = false,
    blocked = false,
    error: string | null = null,
  ) {
    if (this.closed) return;
    this.snapshot = { ...source, preparing, blocked, error };
    for (const listener of this.listeners) listener();
  }
  select(file: File) {
    this.check();
    if (
      this.candidate ||
      this.snapshot.preparing ||
      this.snapshot.blocked ||
      this.clearing
    )
      return Promise.reject(
        new Error(
          "Resolve the current local NBT operation before selecting another file.",
        ),
      );
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void promise.catch(() => {});
    this.candidate = {
      origin: { version: 1, id: crypto.randomUUID(), name: file.name },
      file,
      controller: new AbortController(),
      resolve,
      reject,
    };
    this.publish(this.candidate, true);
    return promise;
  }
  ready(
    originId: string | undefined,
    client: NbtDocumentClient,
    signal: AbortSignal,
  ) {
    const candidate = this.candidate;
    if (!candidate || candidate.origin.id !== originId || candidate.work)
      return candidate?.work ?? Promise.resolve();
    candidate.client = client;
    const active = AbortSignal.any([candidate.controller.signal, signal]);
    candidate.work = (async () => {
      try {
        await client.checkpointRecovery(active);
        active.throwIfAborted();
        this.check();
        await this.pointer.change(candidate.origin);
        this.check();
        if (this.candidate !== candidate) return;
        this.current = { origin: candidate.origin, file: candidate.file };
        this.candidate = undefined;
        this.publish(this.current);
        candidate.resolve();
      } catch (error) {
        if (this.closed) return;
        await this.rejectCandidate(candidate, error);
      }
    })();
    return candidate.work;
  }
  /** Opening can fail before a facade exists. Once ready() runs, it owns all
   * checkpoint/publication errors so a second error callback cannot race it. */
  failed(originId: string | undefined, error: unknown) {
    const candidate = this.candidate;
    if (candidate && candidate.origin.id === originId && !candidate.work) {
      candidate.work = this.rejectCandidate(candidate, error);
      return candidate.work;
    }
    return Promise.resolve();
  }
  private async retire(candidate: Candidate) {
    // No edits were enabled on this unpublished, uniquely identified source.
    // A failed cleanup leaves ciphertext, never a live draft with a new owner.
    try {
      if (candidate.client)
        await nbtSharedDocument(candidate.client)?.closeView();
    } catch {}
  }
  private async rejectCandidate(candidate: Candidate, error: unknown) {
    if (this.candidate !== candidate || this.closed) return;
    let actual: NbtLocalReference | null;
    try {
      actual = this.pointer.value;
    } catch {
      this.publish(candidate, false, true, message(error));
      candidate.reject(error);
      return;
    }
    if (actual?.id === candidate.origin.id) {
      this.current = { origin: candidate.origin, file: candidate.file };
      this.candidate = undefined;
      this.publish(this.current);
      candidate.resolve();
      return;
    }
    await this.retire(candidate);
    if (this.closed || this.candidate !== candidate) return;
    this.candidate = undefined;
    candidate.controller.abort(error);
    this.publish(this.current, false, false, message(error));
    candidate.reject(error);
  }
  async retry() {
    this.check();
    if (this.snapshot.preparing)
      throw new Error("Wait for the local NBT operation to finish.");
    const before = this.snapshot;
    this.publish(before, true, before.blocked, before.error);
    try {
      await this.reconcilePointer();
    } catch (error) {
      this.publish(before, false, true, message(error));
      throw error;
    }
  }
  private async reconcilePointer() {
    const fresh = await this.openPointer();
    if (this.closed) {
      fresh.dispose();
      return;
    }
    const actual = fresh.value,
      candidate = this.candidate,
      file =
        candidate?.origin.id === actual?.id
          ? candidate?.file
          : this.current.origin?.id === actual?.id
            ? this.current.file
            : undefined;
    if (
      !candidate &&
      !this.clearing &&
      actual?.id !== this.current.origin?.id
    ) {
      fresh.dispose();
      this.publish(
        this.current,
        false,
        true,
        "This view's local source changed in another window. Reopen the view to load it.",
      );
      return;
    }
    this.pointer.dispose();
    this.pointer = fresh;
    this.current = { origin: actual, file };
    if (candidate && actual?.id !== candidate.origin.id)
      await this.retire(candidate);
    this.check();
    this.candidate = undefined;
    candidate?.controller.abort(
      new Error("The local source reference was reconciled."),
    );
    candidate?.resolve();
    if (this.clearing && actual) await this.discard();
    else {
      this.clearing = false;
      this.publish(this.current);
    }
  }
  /** Only after the caller has reconciled pending saves and explicitly discarded
   * the underlying local draft. Never called for ordinary renderer unmounts. */
  async discard() {
    this.check();
    if (this.candidate)
      throw new Error("Wait for the local file to finish opening.");
    if (!this.current.origin) return;
    this.clearing = true;
    this.publish(this.current, true);
    try {
      await this.pointer.change(null);
      this.check();
      this.current = { origin: null };
      this.clearing = false;
      this.publish(this.current);
    } catch (error) {
      this.publish(this.current, false, true, message(error));
      throw error;
    }
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("The local NBT view is closed.");
    this.candidate?.controller.abort(error);
    this.candidate?.reject(error);
    this.candidate = undefined;
    this.current = { origin: null };
    this.snapshot = {
      ...this.current,
      preparing: false,
      blocked: true,
      error: null,
    };
    this.pointer.dispose();
    this.listeners.clear();
  }
}
