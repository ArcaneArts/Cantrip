import type { ChatComposerDraft } from "@cantrip/protocol";

const unset = Symbol("unset-chat-composer-draft");
const scopedPersistence = new WeakMap<
  object,
  Map<string, ChatComposerDraftPersistence>
>();

function fingerprint(draft: ChatComposerDraft | null): string {
  return JSON.stringify(draft);
}

export class ChatComposerDraftPersistence {
  private desired: ChatComposerDraft | null | typeof unset = unset;
  private persistedFingerprint: string | null = null;
  private flushPromise: Promise<void> | null = null;
  private retryDelayMs = 1_000;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly save: (
      draft: ChatComposerDraft | null,
    ) => Promise<unknown>,
    private readonly delayMs = 350,
  ) {}

  markPersisted(draft: ChatComposerDraft | null): void {
    this.persistedFingerprint = fingerprint(draft);
  }

  schedule(draft: ChatComposerDraft | null): void {
    this.desired = draft;
    this.retryDelayMs = 1_000;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => undefined);
    }, this.delayMs);
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.flushPromise) {
      this.flushPromise = this.drain().finally(() => {
        this.flushPromise = null;
      });
    }
    return this.flushPromise;
  }

  private async drain(): Promise<void> {
    while (this.desired !== unset) {
      const candidate = this.desired;
      this.desired = unset;
      const candidateFingerprint = fingerprint(candidate);
      if (candidateFingerprint === this.persistedFingerprint) continue;
      try {
        await this.save(candidate);
        this.persistedFingerprint = candidateFingerprint;
        this.retryDelayMs = 1_000;
      } catch (error) {
        if (this.desired === unset) this.desired = candidate;
        this.scheduleRetry();
        throw error;
      }
    }
  }

  private scheduleRetry(): void {
    if (this.timer || this.desired === unset) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 30_000);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => undefined);
    }, delay);
  }
}

export function scopedChatComposerDraftPersistence(
  scope: object,
  chatId: string,
  save: (draft: ChatComposerDraft | null) => Promise<unknown>,
): ChatComposerDraftPersistence {
  let drafts = scopedPersistence.get(scope);
  if (!drafts) {
    drafts = new Map();
    scopedPersistence.set(scope, drafts);
  }
  const existing = drafts.get(chatId);
  if (existing) return existing;
  const created = new ChatComposerDraftPersistence(save);
  drafts.set(chatId, created);
  return created;
}
