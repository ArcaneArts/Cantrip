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
  edit(text: string): void {
    if (this.text !== text) {
      this.text = text;
      this.revision++;
    }
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
    if (this.pendingSave) return this.pendingSave;
    if (!this.dirty) return Promise.resolve(true);
    const content = this.text,
      version = this.version;
    const encoded = this.format.encode(content);
    const pending = Promise.resolve()
      .then(() => write({ content: encoded, version }))
      .then((result) => {
        this.format = textFileFormat(encoded);
        this.baseline = content;
        this.version = result.version;
        return true;
      });
    this.pendingSave = pending;
    void pending
      .finally(() => {
        if (this.pendingSave === pending) this.pendingSave = null;
      })
      .catch(() => {});
    return pending;
  }
}

export class EditorSessionStore {
  private sessions = new Map<string, EditorDocumentSession>();
  constructor(private readonly cleanLimit = 16) {}
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
      (session) => !session.dirty,
    ).length;
    for (const [id, session] of this.sessions) {
      if (clean <= this.cleanLimit) break;
      if (id !== activeId && !session.dirty) {
        this.sessions.delete(id);
        clean--;
      }
    }
  }
  close(id: string): boolean {
    const session = this.sessions.get(id);
    if (session?.dirty) return false;
    this.sessions.delete(id);
    return true;
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
