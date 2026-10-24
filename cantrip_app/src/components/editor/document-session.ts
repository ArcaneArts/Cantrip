import { textChange, type TextChange } from "./syntax/document";
import { EditorInputHistory, type EditorHistoryState } from "./input-history";

export interface EditorIdentity {
  server: string;
  account: string;
  worker: string;
  project: string;
  worktree: string;
  path: string;
}
export const editorDocumentId = (identity: EditorIdentity): string =>
  JSON.stringify([
    identity.server,
    identity.account,
    identity.worker,
    identity.project,
    identity.worktree,
    identity.path,
  ]);

export interface EditorSelection {
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
}

/** Sensitive endpoint-only state: encrypt before transport; never put in layout metadata. */
export interface EditorDocumentTransfer {
  id: string;
  baselineContent: string;
  text: string;
  version: string;
  revision: number;
  selection: EditorSelection;
  scrollTop: number;
  scrollLeft: number;
  saveFailed: boolean;
  history: EditorHistoryState;
}

export interface EditorSessionTransfer {
  scope: string | null;
  documents: EditorDocumentTransfer[];
}

/** In-memory endpoint state. Never persists plaintext documents to storage. */
export class EditorDocumentSession {
  text: string;
  baseline: string;
  version: string;
  revision = 0;
  selection: EditorSelection = { start: 0, end: 0, direction: "none" };
  scrollTop = 0;
  scrollLeft = 0;
  readonly history = new EditorInputHistory();
  private format: ReturnType<typeof textFileFormat>;
  private pendingSave: Promise<boolean> | null = null;
  private pendingContent: string | null = null;
  private saveFailed = false;

  constructor(
    readonly id: string,
    content: string,
    version: string,
  ) {
    this.format = textFileFormat(content);
    this.text = this.format.text;
    this.baseline = this.text;
    this.version = version;
  }

  get dirty(): boolean {
    return this.text !== this.baseline || this.saveFailed;
  }
  get saving(): boolean {
    return this.pendingSave !== null;
  }
  /** The transfer coordinator must suspend input before capturing its final state. */
  async captureTransfer(): Promise<EditorDocumentTransfer> {
    // An actual in-flight write must settle; guessing its result could restore
    // an obsolete version and cause a conflict on the destination's next save.
    while (this.pendingSave) {
      const pending = this.pendingSave;
      await pending.catch(() => {});
      await Promise.resolve();
    }
    return {
      id: this.id,
      baselineContent: this.format.encode(this.baseline),
      text: this.text,
      version: this.version,
      revision: this.revision,
      selection: { ...this.selection },
      scrollTop: this.scrollTop,
      scrollLeft: this.scrollLeft,
      saveFailed: this.saveFailed,
      history: this.history.capture(),
    };
  }
  static fromTransfer(state: EditorDocumentTransfer): EditorDocumentSession {
    const session = new EditorDocumentSession(
      state.id,
      state.baselineContent,
      state.version,
    );
    session.text = state.text;
    session.revision = state.revision;
    session.selection = { ...state.selection };
    session.scrollTop = state.scrollTop;
    session.scrollLeft = state.scrollLeft;
    session.saveFailed = state.saveFailed;
    session.history.restore(state.history);
    return session;
  }
  edit(text: string): void {
    if (this.text !== text) {
      this.text = text;
      this.revision++;
    }
  }
  /** Structured controls share the native editor's document and undo history. */
  editExternal(text: string): void {
    if (text === this.text) return;
    const next = {
      ...this.selection,
      start: Math.min(this.selection.start, text.length),
      end: Math.min(this.selection.end, text.length),
    };
    this.history.record(this.text, text, this.selection, next);
    this.selection = next;
    this.edit(text);
  }

  /** A refresh can observe a new revision, but never overwrites a dirty draft. */
  reconcile(content: string, version: string): void {
    if (this.dirty || this.pendingSave) return;
    const format = textFileFormat(content);
    if (this.text !== format.text) {
      this.revision++;
      this.history.clear();
    }
    this.format = format;
    this.text = format.text;
    this.baseline = format.text;
    this.version = version;
  }

  save(
    write: (input: {
      content: string;
      version: string;
    }) => Promise<{ version: string }>,
  ): Promise<boolean> {
    if (this.pendingSave && this.pendingContent === this.text)
      return this.pendingSave;
    if (!this.pendingSave && !this.dirty) return Promise.resolve(true);
    // Each explicit request captures its text. Later requests wait for the
    // accepted revision; typing alone never schedules another write.
    const content = this.text;
    const commit = async () => {
      const encoded = this.format.encode(content);
      const result = await write({ content: encoded, version: this.version });
      this.format = textFileFormat(encoded);
      this.baseline = content;
      this.version = result.version;
      this.saveFailed = false;
      return true;
    };
    const pending = (this.pendingSave ?? Promise.resolve())
      .then(commit)
      .catch((error: unknown) => {
        // A failed acknowledgement cannot prove that the write did not happen.
        // Even text reverted to the loaded baseline must remain retryable.
        this.saveFailed = true;
        throw error;
      });
    this.pendingSave = pending;
    this.pendingContent = content;
    void pending
      .finally(() => {
        if (this.pendingSave === pending) {
          this.pendingSave = null;
          this.pendingContent = null;
        }
      })
      .catch(() => {});
    return pending;
  }
}

export class EditorSessionStore {
  private sessions = new Map<string, EditorDocumentSession>();
  private scope: string | null = null;
  constructor(private readonly cleanLimit = 16) {}
  resetScope(scope: string): void {
    if (this.scope === scope) return;
    this.sessions.clear();
    this.scope = scope;
  }
  get hasDirtyDocuments(): boolean {
    return [...this.sessions.values()].some(
      (session) => session.dirty || session.saving,
    );
  }
  /** Bind a close answer to all current drafts, including inactive documents. */
  captureCloseGuard(): () => boolean {
    const scope = this.scope;
    const revisions = [...this.sessions.values()].map(
      (session) => [session, session.revision] as const,
    );
    return () =>
      scope === this.scope &&
      revisions.length === this.sessions.size &&
      revisions.every(
        ([session, revision]) =>
          this.sessions.get(session.id) === session &&
          session.revision === revision,
      );
  }
  /** Includes inactive drafts. Callers bind the snapshot to an authorized transfer. */
  async captureTransfer(): Promise<EditorSessionTransfer> {
    const scope = this.scope;
    const sessions = [...this.sessions.values()];
    const documents = await Promise.all(
      sessions.map((session) => session.captureTransfer()),
    );
    if (
      scope !== this.scope ||
      sessions.some((session) => this.sessions.get(session.id) !== session)
    )
      throw new Error("Document ownership changed while preparing transfer.");
    return { scope, documents };
  }
  restoreTransfer(state: EditorSessionTransfer): void {
    if (state.scope !== this.scope)
      throw new Error("Document transfer belongs to another account scope.");
    const restored = new Map<string, EditorDocumentSession>();
    for (const document of state.documents) {
      if (restored.has(document.id))
        throw new Error("Duplicate document in transfer.");
      const existing = this.sessions.get(document.id);
      if (existing?.dirty || existing?.saving)
        throw new Error("Cannot replace a live destination document draft.");
      restored.set(document.id, EditorDocumentSession.fromTransfer(document));
    }
    // Validate the entire batch before changing any session, and do not trim
    // inactive clean views that are part of the handoff.
    for (const [id, session] of restored) this.sessions.set(id, session);
  }
  find(
    predicate: (session: EditorDocumentSession) => boolean,
  ): EditorDocumentSession | undefined {
    for (const session of this.sessions.values())
      if (predicate(session)) return session;
    return undefined;
  }
  get(id: string): EditorDocumentSession | undefined {
    const session = this.sessions.get(id);
    if (session) {
      this.sessions.delete(id);
      this.sessions.set(id, session);
    }
    return session;
  }
  open(id: string, content: string, version: string): EditorDocumentSession {
    const session =
      this.get(id) ?? new EditorDocumentSession(id, content, version);
    session.reconcile(content, version);
    this.sessions.set(id, session);
    this.trim(id);
    return session;
  }
  private trim(activeId: string): void {
    let clean = [...this.sessions.values()].filter(
      (session) => !session.dirty && !session.saving,
    ).length;
    for (const [id, session] of this.sessions) {
      if (clean <= this.cleanLimit) break;
      if (id !== activeId && !session.dirty && !session.saving) {
        this.sessions.delete(id);
        clean--;
      }
    }
  }
  close(id: string): boolean {
    const session = this.sessions.get(id);
    if (session?.dirty || session?.saving) return false;
    this.sessions.delete(id);
    return true;
  }
  /** Call only after the owning UI has explicitly confirmed discarding edits. */
  discard(id: string): void {
    this.sessions.delete(id);
  }
  /** The owning UI must obtain explicit discard confirmation first. */
  discardAll(): void {
    this.sessions.clear();
  }
}

/** Preserve loaded newline/BOM conventions despite textarea LF normalization. */
export function textFileFormat(content: string): {
  text: string;
  encode(text: string): string;
} {
  const bom = content.startsWith("\uFEFF");
  const original = bom ? content.slice(1) : content;
  const lines = original.split(/\r\n|\r|\n/u);
  const endings = original.match(/\r\n|\r|\n/gu) ?? [];
  const preferred =
    endings.find((ending) => ending === "\r\n") ?? endings[0] ?? "\n";
  const normalized = lines.join("\n");
  const rawOffset = (offset: number): number => {
    let normalizedOffset = 0,
      extra = 0;
    for (let index = 0; index < endings.length; index++) {
      normalizedOffset += lines[index]!.length + 1;
      if (normalizedOffset > offset) break;
      extra += endings[index]!.length - 1;
    }
    return offset + extra;
  };
  return {
    text: normalized,
    encode(text) {
      if (text === normalized) return content;
      const change = textChange(normalized, text);
      return (
        (bom ? "\uFEFF" : "") +
        original.slice(0, rawOffset(change.from)) +
        change.insert.replaceAll("\n", preferred) +
        original.slice(rawOffset(change.to))
      );
    },
  };
}

export function applyTextChange(text: string, change: TextChange): string {
  return text.slice(0, change.from) + change.insert + text.slice(change.to);
}
