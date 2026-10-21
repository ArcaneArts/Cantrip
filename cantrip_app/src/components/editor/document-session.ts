import { textChange, type TextChange } from "./syntax/document";
import { EditorInputHistory } from "./input-history";

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
    return this.text !== this.baseline;
  }
  get saving(): boolean {
    return this.pendingSave !== null;
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
      return true;
    };
    const pending = (this.pendingSave ?? Promise.resolve()).then(commit);
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
